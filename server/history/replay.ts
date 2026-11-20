import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { distanceMeters } from '../../src/location-fix.ts';
import type { GeographicEvidence } from '../geography/types.ts';
import { ToolRejection } from '../tool-response.ts';
import type { HistoryReader } from './tool.ts';
import { historyExpiry, SEVEN_DAYS_MS } from './retention.ts';
import { locationHistoryFields, locationHistoryFieldDescriptions, type LocationHistoryField } from './location-fields.ts';

export const HISTORY_RETENTION_MS = SEVEN_DAYS_MS;
export const HISTORY_REPLAY_LIMIT = 10_000;
export const HISTORY_PAGE_BYTES = 48 * 1024;
const instant = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const standardTimezones = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', 'Etc/UTC']);
const timezone = z.string().max(80).refine(value => {
  if (standardTimezones.has(value)) return true;
  // Preserve accepted aliases which Intl does not include in its canonical list.
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
export const historyObservationSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  source: z.enum(['synthetic_fixture', 'phone_location']),
  received_at: instant.optional(),
  measured_at: instant,
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(200),
  speed: z.number().finite().min(0).max(400).optional(), heading: z.number().finite().min(0).lt(360).optional(),
  timezone: timezone.optional(), utc_offset_minutes: z.number().int().min(-840).max(840).optional(),
}).strict();
export type HistoryObservation = z.infer<typeof historyObservationSchema>;
type Observation = HistoryObservation;
export type HistoryEntry = Observation & { recording_epoch: number; expires_at: number };
type Entry = HistoryEntry;
const querySchema = z.object({
  start_at: instant.optional(), end_at: instant.optional(), detail: z.enum(['summary', 'observations']).optional(),
  limit: z.number().int().min(1).max(50).optional(), cursor: z.string().uuid().optional(),
}).strict();
const selectedQuerySchema = z.union([
  querySchema.pick({start_at: true, end_at: true, limit: true}).required().extend({
    fields: z.array(z.enum(locationHistoryFields)).min(1).max(locationHistoryFields.length)
      .refine(fields => new Set(fields).size === fields.length),
  }),
  z.object({cursor: z.string().uuid()}).strict(),
]);
type Query = { start: number; end: number; detail: 'summary' | 'observations'; limit: number; fields?: LocationHistoryField[] };
type Page = { query: Query; offset: number; revision: number };
type Section = { kind: 'candidate_stay' | 'movement_observations' | 'observations'; points: Entry[] };
const stamp = (point: Entry) => Date.parse(point.measured_at);
const point = ({ latitude, longitude, accuracy }: Entry) => ({ latitude, longitude, accuracy });
const invalid = () => new ToolRejection('invalid_arguments', 'Use a bounded time interval with UTC offsets and valid history detail/limit, or only a returned cursor.');
export function grantedExpiry(measured: number, stored: number) {
  if (!Number.isSafeInteger(stored)) throw new Error('Invalid history expiry');
  return Math.min(stored, historyExpiry(measured, '7d'));
}

/**
 * Bounded query index shared by durable phone history and isolated fixtures.
 * Consent, persistence and ingestion authorization belong to the outer owner.
 */
export class LocationHistoryIndex implements HistoryReader {
  private readonly source: HistoryObservation['source'];
  private readonly maximum: number;
  private readonly now: () => number;
  private readonly geography?: (entry: HistoryEntry) => GeographicEvidence | undefined;
  private readonly gapMs: number;
  private readonly stayMs: number;
  private readonly stayRadiusM: number;
  private records = new Map<string, Entry>();
  private cursors = new Map<string, Page>();
  private revision = 0;
  private epoch = 0;
  private recording = false;
  private readable = false;
  private capacityOmitted = false;
  private nextExpiry = Infinity;

  constructor(options: { now: () => number; geography?: (entry: HistoryEntry) => GeographicEvidence | undefined;
    gapMs?: number; stayMs?: number; stayRadiusM?: number; source?: HistoryObservation['source']; maximum?: number }) {
    this.source = options.source ?? 'synthetic_fixture'; this.maximum = options.maximum ?? HISTORY_REPLAY_LIMIT;
    this.now = options.now; this.geography = options.geography;
    this.gapMs = options.gapMs ?? 120_000; this.stayMs = options.stayMs ?? 180_000;
    this.stayRadiusM = options.stayRadiusM ?? 35;
    if (![this.gapMs, this.stayMs, this.stayRadiusM].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid replay thresholds');
  }

  setRecording(enabled: boolean) {
    if (this.recording === enabled) return;
    this.recording = enabled;
    if (enabled) this.epoch++;
    this.changed();
  }
  setReadable(enabled: boolean) {
    if (this.readable === enabled) return;
    this.readable = enabled; this.changed();
  }
  clear() { this.records.clear(); this.capacityOmitted = false; this.nextExpiry = Infinity; this.changed(); }
  private changed() { this.revision++; this.cursors.clear(); }
  private prune() {
    if (this.now() < this.nextExpiry) return;
    const now = this.now();
    let changed = false;
    this.nextExpiry = Infinity;
    for (const [id, value] of this.records) {
      if (value.expires_at <= now) { this.records.delete(id); changed = true; }
      else this.nextExpiry = Math.min(this.nextExpiry, value.expires_at);
    }
    if (changed) this.changed();
  }

  observe(raw: unknown): { accepted: boolean; reason?: 'recording_stopped' | 'expired' | 'duplicate' } {
    if (!this.recording) return { accepted: false, reason: 'recording_stopped' };
    const parsed = historyObservationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.source !== this.source || Date.parse(parsed.data.measured_at) > this.now()) throw invalid();
    this.prune();
    const value = parsed.data;
    value.measured_at = new Date(Date.parse(value.measured_at)).toISOString();
    const expires_at = historyExpiry(Date.parse(value.measured_at), '7d');
    if (expires_at <= this.now()) return { accepted: false, reason: 'expired' };
    const previous = this.records.get(value.id);
    if (previous) {
      const { recording_epoch: _, expires_at: _expiry, ...original } = previous;
      if (JSON.stringify(original) !== JSON.stringify(value)) throw new ToolRejection('observation_conflict', 'An observation ID cannot identify different measurements.');
      return { accepted: false, reason: 'duplicate' };
    }
    this.records.set(value.id, { ...value, recording_epoch: this.epoch, expires_at });
    this.nextExpiry = Math.min(this.nextExpiry, expires_at);
    if (this.records.size > this.maximum) {
      const oldest = this.sorted()[0]; this.records.delete(oldest.id); this.capacityOmitted = true;
    }
    this.changed();
    return { accepted: true };
  }

  snapshot() { this.prune(); return this.sorted(); }
  invalidate() { this.changed(); }
  invalidateAt(measured: number) {
    for (const [cursor, {query}] of this.cursors) {
      if (measured >= query.start && measured < query.end) this.cursors.delete(cursor);
    }
  }

  /** Append a committed phone fix without invalidating unrelated bounded reads. */
  append(entry: HistoryEntry) {
    const {recording_epoch, expires_at: storedExpiry, ...raw} = entry;
    const value = historyObservationSchema.parse(raw), time = stamp(entry);
    if (value.source !== this.source || !Number.isSafeInteger(recording_epoch) || recording_epoch < 0 || time > this.now()) throw invalid();
    const expires_at = grantedExpiry(time, storedExpiry);
    this.prune();
    if (expires_at <= this.now() || this.records.has(value.id)) return;
    this.records.set(value.id, {...value, recording_epoch, expires_at});
    this.epoch = Math.max(this.epoch, recording_epoch);
    this.nextExpiry = Math.min(this.nextExpiry, expires_at);
    let evicted: Entry | undefined;
    if (this.records.size > this.maximum) {
      evicted = this.sorted()[0]; this.records.delete(evicted.id); this.capacityOmitted = true;
    }
    this.invalidateAt(time);
    if (evicted) this.invalidateAt(stamp(evicted));
    return evicted;
  }

  private sorted() { return [...this.records.values()].sort((a, b) => stamp(a) - stamp(b) || a.id.localeCompare(b.id)); }
  private disconnected(a: Entry, b: Entry) { return b.recording_epoch !== a.recording_epoch || stamp(b) - stamp(a) > this.gapMs; }

  /** Linear grouping: observed bounds are never advertised as exact arrival/departure. */
  private sections(points: Entry[]): Section[] {
    const result: Section[] = [];
    let cluster: Entry[] = [], moving: Entry[] = [];
    const flushMoving = () => {
      if (!moving.length) return;
      const first = moving[0];
      const moved = moving.some(p => distanceMeters(first, p) > Math.max(50, first.accuracy + p.accuracy));
      result.push({ kind: moved ? 'movement_observations' : 'observations', points: moving }); moving = [];
    };
    const flushCluster = () => {
      if (!cluster.length) return;
      if (cluster.length > 1 && stamp(cluster.at(-1)!) - stamp(cluster[0]) >= this.stayMs && cluster.every(p => p.accuracy <= this.stayRadiusM)) {
        flushMoving(); result.push({ kind: 'candidate_stay', points: cluster });
      } else moving.push(...cluster);
      cluster = [];
    };
    for (const p of points) {
      const previous = cluster.at(-1) ?? moving.at(-1);
      if (previous && this.disconnected(previous, p)) { flushCluster(); flushMoving(); }
      else if (cluster.length && (distanceMeters(cluster[0], p) > this.stayRadiusM || p.accuracy > this.stayRadiusM)) flushCluster();
      cluster.push(p);
    }
    flushCluster(); flushMoving();
    return result;
  }

  private mapEvidence(entry: Entry) {
    if (!this.geography) return { status: 'unavailable' as const };
    try {
      const evidence = this.geography(entry);
      if (!evidence) return { status: 'unavailable' as const };
      // Reuse relations from the existing resolver; bound reference presentation.
      const refs = (items: GeographicEvidence['lines']) => items.slice(0, 3).map(item => ({
        id: item.id.slice(0, 120), kind: item.kind.slice(0, 60), ...(item.name ? { name: item.name.slice(0, 120) } : {}),
        relation: item.relation, distance_m: item.distance_m,
      }));
      return { status: 'available' as const, source: evidence.source.slice(0, 160), release: evidence.release.slice(0, 80),
        attribution: evidence.attribution.slice(0, 300), license_url: evidence.license_url.slice(0, 300),
        areas: refs(evidence.areas), lines: refs(evidence.lines), landmarks: refs(evidence.landmarks),
        limitations: evidence.limitations.slice(0, 4).map(s => s.slice(0, 200)),
        presentation: 'Bounded nearby references, not road matching or a complete map.' };
    } catch { return { status: 'unavailable' as const }; }
  }

  private present(section: Section, query: Query) {
    const first = section.points[0], last = section.points.at(-1)!;
    if (query.fields) {
      const fields = query.fields;
      return {id: first.id, source: first.source, measured_at: first.measured_at,
        ...(fields.includes('position') ? point(first) : {}),
        ...(fields.includes('motion') ? {speed: first.speed ?? null, heading: first.heading ?? null} : {}),
        ...(fields.includes('clock') ? {received_at: first.received_at ?? null, timezone: first.timezone ?? null,
          utc_offset_minutes: first.utc_offset_minutes ?? null} : {}),
        ...(fields.includes('geography') ? {geography: this.mapEvidence(first)} : {}),
      };
    }
    if (query.detail === 'observations') {
      const { recording_epoch: _, expires_at: _expiry, ...observation } = first;
      return { ...observation, geography: this.mapEvidence(first) };
    }
    const samples = [...new Set([first, section.points[Math.floor(section.points.length / 2)], last])];
    return {
      id: `${section.kind}:${first.id}:${last.id}`, kind: section.kind,
      observed_start_at: first.measured_at, observed_end_at: last.measured_at,
      first_observation_id: first.id, last_observation_id: last.id, observation_count: section.points.length,
      first_position: point(first), last_position: point(last),
      timezone: first.timezone ?? null, utc_offset_minutes: first.utc_offset_minutes ?? null,
      timezone_changed: section.points.some(p => p.timezone !== first.timezone || p.utc_offset_minutes !== first.utc_offset_minutes),
      accuracy_range_m: { min: Math.min(...section.points.map(p => p.accuracy)), max: Math.max(...section.points.map(p => p.accuracy)) },
      geography_samples: samples.map(p => ({ observation_id: p.id, measured_at: p.measured_at, ...this.mapEvidence(p) })),
    };
  }

  read(raw: unknown = {}) {
    return this.readWithExpiry(raw).result;
  }

  readWithExpiry(raw: unknown = {}, stored?: {window: (start: number, end: number) => Entry[]; capacityOmitted: boolean}, selected = false) {
    const parsed = (selected ? selectedQuerySchema : querySchema).safeParse(raw);
    if (!parsed.success) throw invalid();
    const input: z.infer<typeof querySchema> & {fields?: LocationHistoryField[]} = parsed.data;
    if (input.cursor && Object.keys(input).length !== 1) throw invalid();
    this.prune();
    const now = this.now();
    const base = {
      source: this.source, reference_time: new Date(now).toISOString(),
      retention_start_at: new Date(now - HISTORY_RETENTION_MS).toISOString(),
      interpretation: (this.source === 'synthetic_fixture' ? 'Test data only, not the owner’s actual movements. ' : '') + 'Optional reference: absent information does not prevent ordinary conversation. A gap does not require a disclaimer or question. Stays/roads are candidates, not visits or continuous routes.',
    };
    if (!this.readable) return { result: { ...base, status: 'unavailable' as const, entries: [], next_cursor: null }, expiresAt: Infinity };
    let query: Query, offset = 0;
    if (input.cursor) {
      const page = this.cursors.get(input.cursor);
      if (!page || page.revision !== this.revision || Boolean(page.query.fields) !== selected) throw new ToolRejection('history_cursor_expired', 'This history page is no longer available. Make a new bounded query only if still useful to the conversation.');
      query = page.query; offset = page.offset;
    } else {
      query = { start: input.start_at ? Date.parse(input.start_at) : now - HISTORY_RETENTION_MS,
        end: input.end_at ? Date.parse(input.end_at) : now + 1, detail: selected ? 'observations' : (input.detail ?? 'summary'),
        limit: input.limit ?? 20, fields: input.fields };
      if (query.end <= query.start || query.end - query.start > HISTORY_RETENTION_MS + (selected ? 0 : 1)) throw invalid();
    }
    const points = stored ? stored.window(query.start, query.end) : this.sorted().filter(p => stamp(p) >= query.start && stamp(p) < query.end);
    const sections: Section[] = query.detail === 'summary' ? this.sections(points) : points.map(p => ({ kind: 'observations', points: [p] }));
    const gaps: { after: string; before: string; reason: string }[] = [];
    let gapCount = 0;
    for (let i = 1; i < points.length; i++) if (this.disconnected(points[i - 1], points[i])) {
      gapCount++;
      if (gaps.length < 20) gaps.push({ after: points[i - 1].measured_at, before: points[i].measured_at,
        reason: points[i - 1].recording_epoch !== points[i].recording_epoch ? 'recording_boundary' : 'no_observations' });
    }
    const result = {
      ...base, status: points.length ? 'available' as const : 'empty' as const, detail: query.detail,
      query: { start_at: new Date(query.start).toISOString(), end_at: new Date(query.end).toISOString(),
        ...(query.fields ? {fields: [...query.fields]} : {}) },
      ...(query.fields ? {field_definitions: Object.fromEntries(query.fields.map(field => [field, locationHistoryFieldDescriptions[field]]))} : {}),
      coverage: { kind: 'partial_observations', observation_count: points.length,
        first_observed_at: points[0]?.measured_at ?? null, last_observed_at: points.at(-1)?.measured_at ?? null,
        gaps, omitted_gap_count: gapCount - gaps.length, capacity_omissions: stored?.capacityOmitted ?? this.capacityOmitted },
      entries: [] as ReturnType<LocationHistoryIndex['present']>[], next_cursor: null as string | null,
    };
    let next = offset;
    while (next < sections.length && result.entries.length < query.limit) {
      const entry = this.present(sections[next], query);
      result.entries.push(entry);
      if (Buffer.byteLength(JSON.stringify(result)) > HISTORY_PAGE_BYTES - 128) { result.entries.pop(); break; }
      next++;
    }
    if (next < sections.length) {
      if (next === offset) throw new ToolRejection('history_unavailable', 'This history detail is unavailable; continue using other conversation context.');
      const cursor = randomUUID(); this.cursors.set(cursor, { query, offset: next, revision: this.revision });
      while (this.cursors.size > 50) this.cursors.delete(this.cursors.keys().next().value!);
      result.next_cursor = cursor;
    }
    // Coverage and gaps include all matching observations, even on a paged read.
    return {result, expiresAt: points.reduce((earliest, row) => Math.min(earliest, row.expires_at), Infinity)};
  }
}

/** Compatibility fixture owner: production ingestion uses the durable store. */
export class LocationHistoryReplay extends LocationHistoryIndex {}
