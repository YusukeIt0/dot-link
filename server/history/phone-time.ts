import type { HistoryEntry } from './replay.ts';

type ClockPoint = { location_measured_at: string; received_at: string };
type ClockSpan = {
  timezone: string | null; utc_offset_minutes: number | null;
  first: ClockPoint; last: ClockPoint; observation_count: number;
  preceding_gap_seconds: number | null; recording_boundary: boolean;
};

/** Project existing consented uploads only; never collect or assign a Polar clock. */
export function phoneTimeEvidence(entries: HistoryEntry[], dates: string[]) {
  const days = [...new Set(dates)].sort();
  const start = Date.parse(`${days[0]}T00:00:00Z`) - 14 * 3600_000;
  const end = Date.parse(`${days.at(-1)}T00:00:00Z`) + 38 * 3600_000;
  const selected = entries.filter(x => x.received_at && Date.parse(x.received_at) >= start && Date.parse(x.received_at) < end)
    .sort((a,b) => Date.parse(a.received_at!) - Date.parse(b.received_at!));
  const spans: ClockSpan[] = [];
  let previous: HistoryEntry | undefined;
  for (const row of selected) {
    const point = {location_measured_at: row.measured_at, received_at: row.received_at!};
    const gap = previous ? (Date.parse(row.received_at!) - Date.parse(previous.received_at!)) / 1000 : null;
    const boundary = !!previous && previous.recording_epoch !== row.recording_epoch;
    const prior = spans.at(-1);
    if (prior && !boundary && gap! <= 120 && prior.timezone === (row.timezone ?? null) && prior.utc_offset_minutes === (row.utc_offset_minutes ?? null)) {
      prior.last = point; prior.observation_count++;
    } else {
      spans.push({timezone:row.timezone ?? null, utc_offset_minutes:row.utc_offset_minutes ?? null,
        first:point, last:point, observation_count:1, preceding_gap_seconds:gap, recording_boundary:boundary});
    }
    previous = row;
  }
  return {
    evidence: {
      status: selected.length ? 'available' as const : 'empty' as const,
      source: 'consented_phone_history_uploads', source_local_dates: days,
      selection_window: {start_at:new Date(start).toISOString(), end_at:new Date(end).toISOString()},
      spans: spans.slice(-96), omitted_spans: Math.max(0, spans.length - 96),
      observation_count: selected.length,
      provenance: 'Timezone ID and offset were reported by the phone runtime when preparing a history upload. received_at is the Mac receipt time, not the exact clock observation time; location_measured_at timestamps the accompanying location fix. Neither verifies the Polar device clock.',
      interpretation: 'Each span groups adjacent uploads with the same reported timezone and offset, at most 120 seconds apart and within one recording session. It does not prove continuous clock coverage. Gaps, missing fields, omitted spans and changes remain unknown. Use relevant dated spans as candidate clock correspondence only; keep multiple candidates when ambiguous. Never fill the Polar offset or rewrite its source timestamps. No coordinates or places are included.',
    },
    earliestMeasurement: selected.length ? Math.min(...selected.map(x => Date.parse(x.measured_at))) : undefined,
  };
}
export type PhoneTimeEvidence = ReturnType<typeof phoneTimeEvidence>['evidence'];
export type PhoneTimeRead = {evidence: PhoneTimeEvidence | {status:'unavailable'}; allowed?: () => boolean};
