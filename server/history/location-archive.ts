import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GeographicEvidence } from '../geography/types.ts';
import { ToolRejection } from '../tool-response.ts';
import { ArchiveAuthority } from './archive-authority.ts';
import type { ArchiveRecord } from './archive-store.ts';
import type { HistoryPageInput } from './factor-tool.ts';
import type { ClockEntry, ClockWindow } from './phone-time.ts';
import { locationContinuity, type LocationArchiveChange, type LocationTransaction } from './location-continuity.ts';
import { locationHistoryFields, locationHistoryFieldDescriptions, type LocationHistoryField } from './location-fields.ts';
import { historyObservationSchema, locationGaps, mapLocationEvidence, selectedLocationFields, type HistoryObservation } from './replay.ts';
import { SEVEN_DAYS_MS } from './retention.ts';

type Lease = NonNullable<ReturnType<ArchiveAuthority['capture']>>;
type Active = {authority: ArchiveAuthority; lease: Lease; generation: string; erased: string};
type LocationPayload = {kind: 'phone_location'; lineage: string; recording_epoch: number; fix: HistoryObservation; geography?: GeographicEvidence};
type ObservationClock = {measured_at: string; recording_epoch: number};
type Position = {measured: number; id: string};
type State = {active: Active; start: number; end: number; fields: LocationHistoryField[]; limit: number; issued: number; expires: number;
  high: number; highId?: string; protectedDone: boolean; protectedCursor?: string; after?: Position};
type Selected = ReturnType<typeof selectedLocationFields>;
const invalid = () => new ToolRejection('invalid_arguments', 'Choose a bounded period and supported location fields.');
const changed = () => new ToolRejection('history_cursor_expired', 'This location history page is no longer authorized. Use a new bounded query if useful.');
const ttl = 5 * 60_000;

function payload(record: ArchiveRecord, erased: string) {
  const value = record.payload as LocationPayload | null;
  if (record.version !== 1 || value?.kind !== 'phone_location' || value.lineage !== erased) return;
  const fix = historyObservationSchema.parse(value.fix);
  if (fix.id !== record.id || fix.source !== 'phone_location' || Date.parse(fix.measured_at) !== record.fromMs ||
      !fix.received_at || Date.parse(fix.received_at) !== record.availableAtMs || record.toMs !== record.fromMs + 1)
    throw new Error('Invalid protected location record');
  if (!Number.isSafeInteger(value.recording_epoch) || value.recording_epoch < 0) throw new Error('Invalid recording epoch');
  return {fix, epoch: value.recording_epoch, geography: value.geography};
}

/** Compatible recent records remain in their original database for seven days.
 * The separate grant owns every longer retention deadline and all later reads. */
export class LocationArchive {
  private readonly db: DatabaseSync;
  private readonly authority: () => ArchiveAuthority | undefined;
  private readonly now: () => number;
  private readonly pages = new Map<string, State>();
  private readonly geography = new Map<string, Active>();
  private writeFault?: string;

  constructor(db: DatabaseSync, authority: () => ArchiveAuthority | undefined, now: () => number) {
    this.db = db;
    this.authority = authority;
    this.now = now;
  }

  control(owner: string, epoch: string, change: LocationArchiveChange, transaction: LocationTransaction) {
    const authority = this.authority();
    if (!authority) throw new Error('HISTORY_ARCHIVE_UNAVAILABLE');
    return authority.control(owner, epoch, change, transaction);
  }

  reconcile() {
    this.authority()?.reconcileLocation(locationContinuity(this.db));
  }

  active(owner: string) {
    const a = this.authority();
    if (!a) return;
    const fence = locationContinuity(this.db);
    a.reconcileLocation(fence);
    const lease = a.capture(owner, 'location');
    if (!lease) return;
    const generation = a.use(lease, (_key, generation) => generation);
    return {authority: a, lease, generation, erased: fence.erased};
  }

  private allows(ref: Active) {
    try { return this.active(ref.lease.owner)?.lease.stamp === ref.lease.stamp; }
    catch { return false; }
  }

  /** Called for the first admitted upload only, never to backfill earlier records. */
  put(active: Active, fix: HistoryObservation, recordingEpoch: number) {
    const measured = Date.parse(fix.measured_at), available = Date.parse(fix.received_at!);
    // A retry of a seven-day-only observation after its deletion is not a new fix.
    if (measured < active.lease.since) return;
    try {
      const result = active.authority.put(active.lease, {id: fix.id, version: 1, fromMs: measured, toMs: measured + 1,
        availableAtMs: available, indexAvailability: true, anchorMs: Math.min(measured, available),
        payload: {kind:'phone_location', lineage:active.erased, fix, recording_epoch:recordingEpoch} satisfies LocationPayload});
      if (result !== 'stored' && result !== 'duplicate') return;
      this.geography.set(fix.id, active);
      while (this.geography.size > 128) this.geography.delete(this.geography.keys().next().value!);
      return result;
    } catch { this.writeFault = active.lease.stamp; }
  }

  attach(id: string, geo: GeographicEvidence, owner: string) {
    let active = this.geography.get(id);
    if (!active) {
      const row = this.db.prepare('SELECT archive_generation,archive_stamp FROM observations WHERE id=?').get(id);
      if (!row?.archive_stamp) return;
      try { active = this.active(owner); } catch { return; }
      if (active?.generation !== row.archive_generation || active.lease.stamp !== row.archive_stamp) return;
    }
    if (!active || active.lease.owner !== owner || !this.allows(active)) return;
    try {
      active.authority.updatePayload(active.lease, id, record => {
        if (!payload(record, active.erased)) return;
        return {...record.payload as LocationPayload, geography: geo};
      });
    } catch { this.writeFault = active.lease.stamp; }
  }

  /** The health reader may use only the phone clock at upload. A partial scan
   * could hide a conflicting offset, so it never produces a resolved clock. */
  clocks(active: Active, ranges: ClockWindow[]) {
    const entries: ClockEntry[] = [];
    let pages = 0;
    const at = this.now();
    for (const range of ranges) {
      let cursor: string | undefined;
      do {
        if (++pages > 72) return;
        const page = active.authority.read(active.lease, {fromMs: range.start, toMs: range.end,
          knownAtMs: at, axis: 'availability', limit: 100, cursor});
        if (page.capacityOmitted || this.writeFault === active.lease.stamp) return;
        for (const record of page.records) {
          const item = payload(record, active.erased);
          if (!item) return;
          const {id, measured_at, received_at, timezone, utc_offset_minutes} = item.fix;
          entries.push({id, measured_at, received_at, timezone, utc_offset_minutes, recording_epoch:item.epoch, expires_at:record.expiresAtMs});
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return entries;
  }

  guard(active: Active) { return () => this.allows(active); }

  private legacy(state: State, limit: number) {
    const geo = state.fields.includes('geography');
    const keyset = state.after ? 'AND (measured,id)>(?,?)' : '';
    const sql = `SELECT id,measured,expires_at,data${geo ? ',geography' : ''} FROM observations
      WHERE measured>=? AND measured<? AND rowid<=? AND archive_generation IS NOT ?
      ${keyset} ORDER BY measured,id LIMIT ?`;
    return this.db.prepare(sql).all(state.start, state.end, state.high, state.active.generation,
      ...(state.after ? [state.after.measured, state.after.id] : []), limit + 1);
  }

  hasPage(cursor: string) { return this.pages.has(cursor); }

  read(input: HistoryPageInput, owner: string, active: Active, capacityOmitted: boolean) {
    const time = this.now();
    let state: State;
    if ('cursor' in input) {
      const old = this.pages.get(input.cursor);
      if (!old || old.active.lease.stamp !== active.lease.stamp || old.active.lease.owner !== owner ||
          time < old.issued || time >= old.expires) throw changed();
      // v1 rowids can be reused after the newest row is erased. Expire the
      // continuation when that high-water witness disappears or changes.
      if (old.high && this.db.prepare('SELECT id FROM observations WHERE rowid=?').get(old.high)?.id !== old.highId)
        throw changed();
      state = {...old};
    } else {
      const start = Date.parse(input.start_at), end = Date.parse(input.end_at);
      const fields = [...input.fields] as LocationHistoryField[];
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || end-start > SEVEN_DAYS_MS ||
          !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50 || !fields.length ||
          fields.some(f => !locationHistoryFields.includes(f)) || new Set(fields).size !== fields.length) throw invalid();
      const latest = this.db.prepare('SELECT rowid,id FROM observations ORDER BY rowid DESC LIMIT 1').get();
      state = {active, start, end, fields, limit: Math.min(input.limit, fields.includes('geography') ? 8 : 50),
        high: Number(latest?.rowid ?? 0), highId: latest && String(latest.id),
        issued: time, expires: time + ttl, protectedDone:false};
    }
    const entries: Selected[] = [];
    const clocks: ObservationClock[] = [];
    let evidenceExpiry = Infinity;
    let pressure = false, unsupported = 0;
    const fallback = this.db.prepare('SELECT 1 FROM observations WHERE id=? AND archive_generation IS NOT ?');
    for (let scan=0; !state.protectedDone && scan < 3; scan++) {
      const raw = active.authority.read(active.lease, {fromMs:state.start, toMs:state.end, knownAtMs:state.issued,
        limit:state.limit, cursor:state.protectedCursor});
      pressure ||= raw.capacityOmitted;
      for (const record of raw.records) {
        // A crash between the two stores may leave a legacy copy unmarked.
        // In that case the original seven-day row supplies the one visible copy.
        if (fallback.get(record.id, active.generation)) continue;
        const item = payload(record, active.erased);
        if (!item) { unsupported++; continue; }
        clocks.push({measured_at:item.fix.measured_at, recording_epoch:item.epoch});
        entries.push(selectedLocationFields(item.fix, state.fields, () => mapLocationEvidence(item.geography)));
        evidenceExpiry = Math.min(evidenceExpiry, record.expiresAtMs);
      }
      state.protectedCursor = raw.nextCursor ?? undefined;
      state.protectedDone = !raw.nextCursor;
      if (entries.length) break;
    }
    let more = !state.protectedDone;
    if (state.protectedDone) {
      const room = state.limit - entries.length;
      const rows = this.legacy(state, room);
      more = rows.length > room;
      for (const row of rows.slice(0, room)) {
        const stored = JSON.parse(row.data as string);
        const {recording_epoch, ...raw} = stored;
        const fix = historyObservationSchema.parse(raw);
        if (!Number.isSafeInteger(recording_epoch) || recording_epoch < 0 || fix.id !== row.id ||
            Date.parse(fix.measured_at) !== row.measured || fix.source !== 'phone_location') throw new Error('Invalid location observation');
        clocks.push({measured_at:fix.measured_at, recording_epoch});
        entries.push(selectedLocationFields(fix, state.fields, () =>
          mapLocationEvidence(row.geography ? JSON.parse(String(row.geography)) as GeographicEvidence : undefined)));
        evidenceExpiry = Math.min(evidenceExpiry, Number(row.expires_at));
        state.after = {measured:Number(row.measured), id:String(row.id)};
      }
    }
    state.expires = Math.min(state.expires, evidenceExpiry);
    const grantAllowed = () => this.now() >= state.issued && this.allows(active);
    if (this.now() >= state.expires || !grantAllowed()) throw changed();
    let next: string | null = null;
    if (more) {
      next = randomUUID();
      this.pages.set(next, state);
      while (this.pages.size > 50) this.pages.delete(this.pages.keys().next().value!);
    }
    const partial = pressure || capacityOmitted || this.writeFault === active.lease.stamp || unsupported > 0 || (!entries.length && more);
    const wholeWindow = !('cursor' in input) && !more && !partial;
    if (wholeWindow) clocks.sort((a,b) => Date.parse(a.measured_at) - Date.parse(b.measured_at));
    const gapCoverage = wholeWindow ? locationGaps(clocks) : {gaps:[], omitted_gap_count:null};
    const result = {source:'phone_location' as const, status: partial ? 'partial' : entries.length ? 'available' : wholeWindow ? 'empty' : 'partial', detail:'observations' as const,
      reference_time: new Date(state.issued).toISOString(), query: {start_at:new Date(state.start).toISOString(), end_at:new Date(state.end).toISOString(), fields:state.fields},
      field_definitions: Object.fromEntries(state.fields.map(f => [f,locationHistoryFieldDescriptions[f]])),
      coverage: {kind:'partial_observations', returned_records:entries.length, more_pages:more,
        observation_count:wholeWindow ? entries.length : null, gaps_evaluated:wholeWindow, ...gapCoverage,
        first_observed_at:wholeWindow ? clocks[0]?.measured_at ?? null : null, last_observed_at:wholeWindow ? clocks.at(-1)?.measured_at ?? null : null,
        legacy_capacity_omissions:capacityOmitted, archive_capacity_omissions:pressure, unsupported_records:unsupported,
        archive_write_error_this_grant_since_restart:this.writeFault === active.lease.stamp,
        order:'protected_window_then_remaining_recent_observations', interpretation:'Each entry is one retained phone observation. Gaps do not establish inactivity.'},
      entries, next_cursor:next};
    return {result, grantAllowed, expires:state.expires, evidenceExpiry};
  }

  clear() { this.pages.clear(); this.geography.clear(); }
}
