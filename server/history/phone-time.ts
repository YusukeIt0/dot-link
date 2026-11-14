import type { HistoryEntry } from './replay.ts';

type ClockPoint = { location_measured_at: string; received_at: string };
type ClockSpan = {
  timezone: string | null; utc_offset_minutes: number | null;
  first: ClockPoint; last: ClockPoint; observation_count: number;
  preceding_gap_seconds: number | null; recording_boundary: boolean;
};
const clockKey = (span: ClockSpan) => JSON.stringify([span.timezone, span.utc_offset_minutes]);
function boundedSpans(spans: ClockSpan[], limit: number) {
  if (spans.length <= limit) return spans;
  const indexes = new Set([0, spans.length - 1]);
  // Preserve differing clock candidates before filling the remaining time detail.
  const clocks = new Set([...indexes].map(i => clockKey(spans[i])));
  for (let i=0; i<spans.length && indexes.size<limit; i++) {
    const key=clockKey(spans[i]);
    if (!clocks.has(key)) { clocks.add(key); indexes.add(i); }
  }
  for (let i=0; i<limit && indexes.size<limit; i++) indexes.add(Math.floor(i*(spans.length-1)/(limit-1)));
  return [...indexes].sort((a,b)=>a-b).map(i=>spans[i]);
}
function spansFor(selected: HistoryEntry[]) {
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
  return spans;
}

/** Project existing consented uploads only; never collect or assign a Polar clock. */
export function phoneTimeEvidence(entries: HistoryEntry[], dates: string[]) {
  const days = [...new Set(dates)].sort();
  const sorted = entries.filter(x=>x.received_at).sort((a,b)=>Date.parse(a.received_at!)-Date.parse(b.received_at!));
  // Health retention permits at most eight source dates. Keep a bounded budget
  // per date so sparse recent uploads cannot evict all evidence for an older day.
  const limit = Math.max(2, Math.floor(96/days.length));
  const retained = new Set<HistoryEntry>();
  const byDate = days.map(date=>{
    const start=Date.parse(`${date}T00:00:00Z`)-14*3600_000, end=start+52*3600_000;
    const selected=sorted.filter(x=>Date.parse(x.received_at!)>=start&&Date.parse(x.received_at!)<end);
    for(const row of selected)retained.add(row);
    const all=spansFor(selected), spans=boundedSpans(all,limit);
    return {source_local_date:date, selection_window:{start_at:new Date(start).toISOString(),end_at:new Date(end).toISOString()},
      spans, observation_count:selected.length, omitted_spans:all.length-spans.length,
      omitted_clock_candidates:new Set(all.map(clockKey)).size-new Set(spans.map(clockKey)).size};
  });
  return {
    evidence: {
      status: retained.size ? 'available' as const : 'empty' as const,
      source: 'consented_phone_history_uploads', by_source_date:byDate,
      provenance: 'Timezone ID and offset were reported by the phone runtime when preparing a history upload. received_at is the Mac receipt time, not the exact clock observation time; location_measured_at timestamps the accompanying location fix. Neither verifies the Polar device clock.',
      interpretation: 'Each source date has a potentially overlapping UTC window, not verified alignment; windows may reuse uploads. Each span groups adjacent uploads with the same reported timezone and offset, at most 120 seconds apart and within one recording session. It does not prove continuous clock coverage. Gaps, missing fields and per-date omissions remain unknown. Use dated spans as candidate clock correspondence only; keep multiple candidates when ambiguous. Never fill the Polar offset or rewrite its timestamps. No coordinates or places are included.',
    },
    earliestMeasurement: retained.size ? Math.min(...[...retained].map(x => Date.parse(x.measured_at))) : undefined,
  };
}
export type PhoneTimeEvidence = ReturnType<typeof phoneTimeEvidence>['evidence'];
export type PhoneTimeRead = {evidence: PhoneTimeEvidence | {status:'unavailable'}; allowed?: () => boolean};
