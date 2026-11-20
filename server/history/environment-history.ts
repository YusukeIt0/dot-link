import { randomUUID } from 'node:crypto';
import { ToolRejection } from '../tool-response.ts';
import { ArchiveAuthority, type ArchiveLease } from './archive-authority.ts';
import type { ArchiveInput, ArchiveQuery, ArchiveRecord } from './archive-store.ts';
import { environmentFields, projectEnvironment } from './environment-fields.ts';
import type { HistoryPageInput, SelectedHistoryReader } from './factor-tool.ts';

type Source = 'weather' | 'mobility';
type Capture = ((row: ArchiveInput) => void) & {readonly since: number};
type Reference = {lease: ArchiveLease; issuedAt: number; expires: number};
type Window = {start: number; end: number};
type Selection = Reference & {source: Source; fields: readonly string[]; window: Window; query: ArchiveQuery};
type Cursor = Selection & {query: ArchiveQuery & {cursor: string}};

const lifetime = 5 * 60_000;
const pageBytes = 48 * 1024;
const maximumSourceRecords = 10;
const unavailable = () => ({status: 'unavailable', entries: [], next_cursor: null});
const changed = () => new ToolRejection('history_access_changed', 'Historical access changed. Use the currently authorized evidence.');
const invalid = () => new ToolRejection('invalid_arguments', 'Choose supported fields and a bounded interval for this source.');
const byteSize = (data: object) => Buffer.byteLength(JSON.stringify(data));

function remember<T extends Reference>(map: Map<string, T>, value: T, now: number, maximum: number) {
  for (const [id, entry] of map) if (entry.expires <= now) map.delete(id);
  while (map.size >= maximum) map.delete(map.keys().next().value!);
  const id = randomUUID();
  map.set(id, value);
  return id;
}

/** Keep bounded evidence useful if an exceptionally detailed result cannot fit.
 * Only explicitly requested fields are eligible, including on the fallback. */
function project(source: Source, row: ArchiveRecord, fields: readonly string[], window: Window, budget: number) {
  const full = projectEnvironment(source, row, fields, window);
  if (!full || byteSize(full) <= budget) return {entry: full, reduced: false};
  const kept: string[] = [];
  let subset: object | null = null;
  for (const field of fields) {
    const candidate = projectEnvironment(source, row, [...kept, field], window);
    if (candidate && byteSize(candidate) < budget - 512) { kept.push(field); subset = candidate; }
  }
  const basis = subset ?? {data_kind: source === 'weather' ? 'model_forecast' : 'planned_route_or_model_terrain',
    available_at: new Date(row.availableAtMs).toISOString()};
  return {entry: {...basis, omitted_fields: fields.filter(field => !kept.includes(field)),
    detail_status: 'requested_fields_exceed_page_budget'}, reduced: true};
}

/** Archive reads rely on their own owner grant. Acquiring providers and their
 * live permissions belong to the existing weather and mobility contexts. */
export class EnvironmentHistory {
  private readonly authority: ArchiveAuthority;
  private readonly now: () => number;
  private readonly cursors = new Map<string, Cursor>();
  private readonly receipts = new Map<string, Reference>();
  private readonly captureFault = new Map<Source, string>();

  constructor(authority: ArchiveAuthority, now: () => number = Date.now) {
    this.authority = authority;
    this.now = now;
  }

  capture(owner: string, source: Source): Capture | undefined {
    let lease: ArchiveLease | undefined;
    try { lease = this.authority.capture(owner, source); } catch { return; }
    if (!lease) return;
    const grant = lease;
    return Object.assign((row: ArchiveInput) => {
      try { this.authority.put(grant, row); }
      catch {
        // An optional archive must not break the live reply. A genuine storage
        // failure under this grant makes subsequent coverage visibly partial.
        if (this.authority.allows(grant)) this.captureFault.set(source, grant.stamp);
      }
    }, {since: grant.since});
  }

  reader(source: Source) {
    return {
      historyOwner: () => this.authority.historyOwner(source),
      readSelectedHistory: input => this.read(source, input),
      responseGuard: id => () => this.receipts.get(id)?.lease.source === source && !!this.responseContext(id),
    } satisfies SelectedHistoryReader;
  }

  responseContext(id: string) {
    const receipt = this.receipts.get(id);
    if (!receipt) return;
    const guard = () => {
      if (this.receipts.get(id) !== receipt) return false;
      if (this.allowed(receipt)) return true;
      this.receipts.delete(id);
      return false;
    };
    if (guard()) return {owner: receipt.lease.owner, guard};
  }

  private allowed(ref: Reference) {
    const now = this.now();
    return ref.issuedAt <= now && now < ref.expires && this.authority.allows(ref.lease);
  }

  private select(source: Source, input: HistoryPageInput): Selection | undefined {
    if ('cursor' in input) {
      const saved = this.cursors.get(input.cursor);
      if (!saved || saved.source !== source) throw changed();
      if (!this.allowed(saved)) { this.cursors.delete(input.cursor); throw changed(); }
      return saved;
    }
    const now = this.now();
    const start = Date.parse(input.start_at), end = Date.parse(input.end_at);
    const known = input.known_at === undefined ? now : Date.parse(input.known_at);
    const supported: readonly string[] = environmentFields[source];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || end - start > 366 * 86_400_000 ||
        !Number.isSafeInteger(known) || known > now || (input.known_at !== undefined && source !== 'weather') ||
        !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50 ||
        !input.fields.length || new Set(input.fields).size !== input.fields.length ||
        !input.fields.every(field => supported.includes(field))) throw invalid();
    const owner = this.authority.historyOwner(source);
    const lease = owner && this.authority.capture(owner, source);
    if (!lease) return;
    return {lease, source, fields: [...input.fields], window: {start, end}, issuedAt: now, expires: now + lifetime,
      query: {fromMs: start, toMs: end, knownAtMs: known, limit: Math.min(input.limit, maximumSourceRecords), maxBytes: 16 * 1024}};
  }

  private read(source: Source, input: HistoryPageInput) {
    const selection = this.select(source, input);
    if (!selection) return unavailable();
    const {lease, fields, window, query} = selection;
    let expires = selection.expires;
    let bytesLeft = pageBytes - 1536;
    let unsupported = 0, reduced = 0, unreadable = 0, capacityOmitted = false;
    const entries: object[] = [];
    let position = query.cursor;
    // Different fields can occupy separate parts of one forecast or route.
    // Skip unrelated parts locally, keeping a firm work bound on sparse windows.
    for (let scan = 0; scan < 4; scan++) {
      let batch: ReturnType<ArchiveAuthority['read']>;
      try { batch = this.authority.read(lease, {...query, cursor: position}); }
      catch {
        if (!this.authority.allows(lease) || 'cursor' in input) throw changed();
        return unavailable();
      }
      capacityOmitted ||= batch.capacityOmitted;
      for (const [index, row] of batch.records.entries()) {
        expires = Math.min(expires, row.expiresAtMs);
        if (row.version !== 1) { unsupported++; continue; }
        try {
          const budget = bytesLeft - 512 * (batch.records.length - index - 1);
          const {entry, reduced: limited} = project(source, row, fields, window, budget);
          if (!entry) continue;
          entries.push(entry);
          bytesLeft -= byteSize(entry) + 1;
          if (limited) reduced++;
        } catch { unreadable++; }
      }
      position = batch.nextCursor ?? undefined;
      if (entries.length || !position) break;
    }
    const ref = {lease, issuedAt: selection.issuedAt, expires};
    if (!this.allowed(ref)) throw changed();
    const now = this.now();
    const id = remember(this.receipts, ref, now, 96);
    const next = position ? remember(this.cursors, {...selection, expires, query: {...query, cursor: position}}, now, 40) : null;
    const failed = this.captureFault.get(source) === lease.stamp;
    const partial = capacityOmitted || failed || unsupported > 0 || unreadable > 0 || reduced > 0 || (!entries.length && !!next);
    return {
      status: partial ? 'partial' : entries.length ? 'available' : 'empty',
      entries, next_cursor: next,
      coverage: {returned_records: entries.length, capacity_omitted: capacityOmitted, capture_error_this_grant_since_restart: failed,
        unsupported_version_records: unsupported, unreadable_records: unreadable, reduced_records: reduced, more_pages: !!next,
        known_at: new Date(query.knownAtMs!).toISOString(), scope: 'retained_authorized_records_only'},
      response_context: {tool: 'respond_to_context', arguments: {archive_read_ids: [id]}, expires_no_later_than: new Date(expires).toISOString()},
    };
  }
}
