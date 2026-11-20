import type { DatabaseSync } from 'node:sqlite';
import { grantedExpiry, historyObservationSchema, type HistoryEntry } from './replay.ts';

type ClockEntry = Pick<HistoryEntry, 'id' | 'measured_at' | 'received_at' | 'recording_epoch' | 'timezone' | 'utc_offset_minutes' | 'expires_at'>;
type TimedClock = ClockEntry & {received_at: string; received: number; measured: number};
type Window = {start: number; end: number};
function dateWindow(date: string): Window {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const start = midnight - 14 * 3600_000;
  return {start, end: start + 52 * 3600_000};
}

// All window edges fall on whole minutes. Index the UTC minute to avoid
// SQLite rounding submillisecond receipts across a window edge. Read the
// original timestamp for the precise order and provenance inside the window.
const receipt = "json_extract(data, '$.received_at')";
const offset = `substr(replace(${receipt}, ':', ''), -5)`;
const receiptMinute = `(unixepoch(substr(${receipt}, 1, 16)) -
  CASE WHEN substr(${receipt}, -1) = 'Z' THEN 0 ELSE
    (CASE substr(${offset}, 1, 1) WHEN '-' THEN -1 ELSE 1 END) *
    (3600 * CAST(substr(${offset}, 2, 2) AS INTEGER) + 60 * CAST(substr(${offset}, 4, 2) AS INTEGER)) END)`;

export function installPhoneTimeIndex(db: DatabaseSync) {
  // Only built-in functions: legacy writers can maintain this index as-is.
  db.exec(`CREATE INDEX IF NOT EXISTS observation_receipt_minute ON observations(${receiptMinute})`);
}

// The relay and current phones normally write canonical UTC. For any other
// spelling, validate the original observation schema and retain its exact text.
function clockInstant(value: string, expected?: number) {
  if (typeof value !== 'string') throw new Error('Invalid stored phone timestamp');
  const time = expected ?? Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Invalid stored phone timestamp');
  if (value.length !== 24 || new Date(time).toISOString() !== value) {
    historyObservationSchema.shape.measured_at.parse(value);
    if (expected !== undefined && Date.parse(value) !== expected) throw new Error('Invalid stored measurement time');
  }
  return time;
}

export function readStoredPhoneTime(db: DatabaseSync, dates: string[]) {
  // The existing Polar read supplies at most 80 observations, often sharing dates.
  const unavailable = {evidence: {status: 'unavailable' as const}, earliestExpiry: undefined};
  if (dates.length > 80) return unavailable;
  const days = [...new Set(dates)].sort();
  const ranges: Window[] = [];
  for (const date of days) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return unavailable;
    const midnight = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0,10) !== date) return unavailable;
    const window = dateWindow(date), prior = ranges.at(-1);
    if (prior && window.start <= prior.end) prior.end = Math.max(prior.end, window.end);
    else ranges.push(window);
  }
  const select = db.prepare(`SELECT measured, expires_at, id, json_extract(data, '$.id', '$.source',
    '$.measured_at', '$.received_at', '$.timezone', '$.utc_offset_minutes', '$.recording_epoch') AS clock
    FROM observations WHERE ${receiptMinute} >= ? AND ${receiptMinute} < ?`);
  const entries: TimedClock[] = [];
  const zones = new Set<string>();
  for (const range of ranges) {
    for (const raw of select.iterate(range.start / 1000, range.end / 1000)) {
      const {id, measured, expires_at} = raw;
      const [storedId, source, measured_at, received_at, timezone, utc_offset_minutes, recording_epoch] = JSON.parse(raw.clock as string);
      if (storedId !== id || source !== 'phone_location' || typeof measured !== 'number' ||
          typeof expires_at !== 'number' || !Number.isSafeInteger(recording_epoch) || Number(recording_epoch) < 0)
        throw new Error('Invalid stored phone clock');
      if (typeof timezone === 'string' && !zones.has(timezone)) {
        historyObservationSchema.shape.timezone.parse(timezone);
        zones.add(timezone);
      }
      if (timezone !== null && typeof timezone !== 'string') throw new Error('Invalid stored phone timezone');
      clockInstant(measured_at, measured);
      entries.push({measured, received: clockInstant(received_at), id: historyObservationSchema.shape.id.parse(id),
        measured_at, received_at,
        recording_epoch: Number(recording_epoch), timezone: timezone ?? undefined,
        utc_offset_minutes: historyObservationSchema.shape.utc_offset_minutes.parse(utc_offset_minutes ?? undefined),
        expires_at: grantedExpiry(measured, expires_at)});
    }
  }
  return projectClocks(entries, days);
}

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
function spansFor(selected: TimedClock[]) {
  const spans: ClockSpan[] = [];
  let previous: TimedClock | undefined;
  for (const row of selected) {
    const point = {location_measured_at: row.measured_at, received_at: row.received_at};
    const gap = previous ? (row.received - previous.received) / 1000 : null;
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

// A product interpretation convention, not a provider measurement timestamp.
// Resolve before bounding spans so omitted clock changes cannot disappear.
function referenceForDate(rows: TimedClock[], midnight: number) {
  const dated = rows.filter(row => {
    if (typeof row.utc_offset_minutes !== 'number') return false;
    const local = row.received + row.utc_offset_minutes * 60_000;
    return local >= midnight && local < midnight + 86_400_000;
  });
  const offsets = [...new Set(dated.map(row => row.utc_offset_minutes!))];
  const incomplete = rows.some(row => row.utc_offset_minutes == null);
  const resolved = offsets.length === 1 && !incomplete;
  return {status: resolved ? 'resolved' : offsets.length > 1 ? 'ambiguous' : 'unavailable',
    basis: 'record_date_phone_timezone', meaning: 'Resolved means a single adopted phone offset for this source date, not verified Polar synchronization.', utc_offset_minutes: resolved ? offsets[0] : null,
    timezones: [...new Set(dated.map(row => row.timezone).filter((x): x is string => !!x))],
    observation_count: dated.length,
    first_received_at: dated[0]?.received_at ?? null, last_received_at: dated.at(-1)?.received_at ?? null};
}

/** Project existing consented uploads; preserve the original Polar clock. */
export function phoneTimeEvidence(entries: ClockEntry[], dates: string[]) {
  const clocks: TimedClock[] = [];
  for (const row of entries) if (row.received_at) clocks.push({...row, received_at: row.received_at,
    received: Date.parse(row.received_at), measured: Date.parse(row.measured_at)});
  return projectClocks(clocks, [...new Set(dates)].sort());
}

function projectClocks(clocks: TimedClock[], days: string[]) {
  // The previous durable snapshot broke equal receipt times by measurement then ID.
  clocks.sort((a,b)=>a.received-b.received || a.measured-b.measured || a.id.localeCompare(b.id));
  // Health retention permits at most eight source dates. Keep a bounded budget
  // per date so sparse recent uploads cannot evict all evidence for an older day.
  const limit = Math.max(2, Math.floor(96/days.length));
  let earliestExpiry: number | undefined;
  const byDate = days.map(date=>{
    const {start,end}=dateWindow(date);
    const selected=clocks.filter(x=>x.received>=start&&x.received<end);
    for (const row of selected) earliestExpiry = Math.min(earliestExpiry ?? Infinity, row.expires_at);
    const all=spansFor(selected), spans=boundedSpans(all,limit);
    return {source_local_date:date, selection_window:{start_at:new Date(start).toISOString(),end_at:new Date(end).toISOString()},
      reference:referenceForDate(selected,start + 14 * 3600_000), spans, observation_count:selected.length, omitted_spans:all.length-spans.length,
      omitted_clock_candidates:new Set(all.map(clockKey)).size-new Set(spans.map(clockKey)).size};
  });
  return {
    evidence: {
      status: earliestExpiry !== undefined ? 'available' as const : 'empty' as const,
      source: 'consented_phone_history_uploads', by_source_date:byDate,
      provenance: 'Timezone ID and offset were reported by the phone runtime when preparing a history upload. received_at is the Mac receipt time, not the exact clock observation time; location_measured_at timestamps the accompanying location fix. Neither verifies the Polar device clock.',
      interpretation: 'Each source date has a potentially overlapping UTC window, not verified alignment; windows may reuse uploads. Each span groups adjacent uploads with the same reported timezone and offset, at most 120 seconds apart and within one recording session. It does not prove continuous clock coverage. Gaps, missing fields and per-date omissions remain unknown. Use a resolved per-date reference as the normal phone-based interpretation of offset-free health times, including conversation/event comparisons, without routine timezone caveats or user clock management. This is a product convention, not verified Polar synchronization. Preserve source timestamps. For ambiguous references use the dated spans only where the relevant period is distinguishable; otherwise leave event ordering unresolved when it affects the answer. Unavailable references do not inherit the current phone timezone. Gaps do not establish continuous sampling or a maximum clock error. No coordinates or places are included.',
    },
    earliestExpiry,
  };
}
export type PhoneTimeEvidence = ReturnType<typeof phoneTimeEvidence>['evidence'];
export type PhoneTimeRead = {evidence: PhoneTimeEvidence | {status:'unavailable'}; allowed?: () => boolean};
