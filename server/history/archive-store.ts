import { createHmac, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { openArchive, sealArchive } from './archive-crypto.ts';
import { historyExpiry, type HistoryPeriod } from './retention.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_WINDOW = 366 * DAY;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_INSPECT = 128;
const VERSION = 1;
const selectBucket = `SELECT d.n AS n,e.token,e.body FROM days d JOIN entries e ON e.n=d.n
  WHERE d.bucket=? AND d.n>? AND d.n<=?`;
const PERIODS: readonly HistoryPeriod[] = ['7d', '1m', '6m', '1y'];
const ENVELOPE = 'dot-link:factor-archive:v1:';

export interface ArchiveInput {
  /** Stable across retries (and distinct for separate forecast revisions). */
  id: string;
  version: number;
  /** Source-defined half-open interval, e.g. a point is [at, at + 1). */
  fromMs: number;
  toMs: number;
  availableAtMs: number;
  anchorMs: number;
  payload: unknown;
}
export interface ArchiveRecord extends ArchiveInput {
  expiresAtMs: number;
  period: HistoryPeriod;
}
export interface ArchiveQuery {
  fromMs: number;
  toMs: number;
  knownAtMs?: number;
  limit?: number;
  cursor?: string;
}
type Position = { day: number; after: number };
type PageCursor = Position & {
  generation: string; high: number; from: number; to: number; known: number | null; limit: number;
};
type DatabaseState = {
  generation: string;
  count: number;
  bytes: number;
  capacityOmitted: boolean;
  dueDays: number[];
  sweep: Position | null;
};
type DuplicateMarker = { forgetDay: number };
type Stored = { record: ArchiveRecord } | DuplicateMarker;
type Row = { n: number; token: string; body: Uint8Array };
type Options = { now?: () => number; maxRecords?: number; maxBytes?: number; existingOnly?: boolean };
const dayOf = (ms: number) => Math.floor(ms / DAY);
const validTime = (ms: number) => Number.isSafeInteger(ms) && Math.abs(ms) <= 8.64e15;
function validWindow(from: number, to: number) {
  return validTime(from) && validTime(to) && from < to && to - from <= MAX_WINDOW;
}
function initial(): DatabaseState {
  return {generation: randomUUID(), count: 0, bytes: 0, capacityOmitted: false, dueDays: [], sweep: null};
}
function addDueDay(state: DatabaseState, day: number) {
  if (!state.dueDays.includes(day)) {
    state.dueDays.push(day);
    state.dueDays.sort((a, b) => a - b);
  }
}
function duplicateMarker(anchorMs: number, now: number): DuplicateMarker | undefined {
  const latest = historyExpiry(anchorMs, '1y');
  // The archive needs an opaque equality check after expiry, not the original
  // measurement instant. Round up so forgetting can never make it eligible again.
  if (latest > now) return {forgetDay: Math.ceil(latest / DAY)};
}
function intervalDays(record: ArchiveInput) {
  return dayOf(record.toMs - 1) - dayOf(record.fromMs) + 1;
}
// Charge fixed row/index overhead as well as ciphertext. This is a logical
// capacity budget, independent of SQLite page overhead and journal space.
function cost(body: Uint8Array, buckets: number) { return body.length + 256 + 128 * buckets; }

/** Each file uses one independently managed owner/source generation key. The
 * database reveals ciphertext lengths, row counts and equality of bucket tags.
 * Source authorities must authorize every operation and rotate the key on erase. */
export class HistoryArchiveStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly indexKey: Buffer;
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly statements = new Map<string, StatementSync>();
  private nextMaintenance = -Infinity;

  constructor(path: string, key: Buffer, options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? 1_200_000;
    this.maxBytes = options.maxBytes ?? 768 * 1024 * 1024;
    if (key.length !== 32 || !Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 ||
        !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error('Invalid archive configuration');
    const folder = dirname(path);
    mkdirSync(folder, {recursive: true, mode: 0o700});
    const directory = lstatSync(folder);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error('Private archive directory required');
    for (const name of [path, path + '-journal', path + '-wal', path + '-shm']) {
      const info = lstatSync(name, {throwIfNoEntry: false});
      if (info && (!info.isFile() || info.nlink !== 1)) throw new Error('Invalid archive file');
    }
    const flags = constants.O_NOFOLLOW | constants.O_RDWR | (options.existingOnly ? 0 : constants.O_CREAT);
    const fd = openSync(path, flags, 0o600);
    closeSync(fd);
    chmodSync(path, 0o600);
    this.key = Buffer.from(key);
    this.indexKey = createHmac('sha256', key).update(ENVELOPE + 'index-key').digest();
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=1500; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        const version = this.sql('PRAGMA user_version').get()?.user_version;
        if (version === VERSION) { this.state(); return; }
        if (options.existingOnly || version !== 0 || this.sql('SELECT 1 FROM sqlite_schema LIMIT 1').get())
          throw new Error('Unsupported history archive');
        this.db.exec(`
          CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL);
          CREATE TABLE entries (n INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, due TEXT NOT NULL, body BLOB NOT NULL);
          CREATE INDEX due_entries ON entries(due,n);
          CREATE TABLE days (bucket TEXT NOT NULL, n INTEGER NOT NULL REFERENCES entries(n) ON DELETE CASCADE, PRIMARY KEY(bucket,n)) WITHOUT ROWID;
          CREATE INDEX entry_days ON days(n);
          PRAGMA user_version=1;
        `);
        this.save(initial());
      });
    } catch (error) { this.close(); throw error; }
  }

  private sql(text: string) {
    let statement = this.statements.get(text);
    if (!statement) { statement = this.db.prepare(text); this.statements.set(text, statement); }
    return statement;
  }
  private transaction<T>(work: () => T, mode: 'BEGIN' | 'BEGIN IMMEDIATE' = 'BEGIN IMMEDIATE') {
    this.db.exec(mode);
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  private tag(namespace: string, value: string | number) {
    return createHmac('sha256', this.indexKey).update(ENVELOPE + namespace + '\0' + value).digest('base64url');
  }
  private pack(purpose: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    try { return sealArchive(this.key, ENVELOPE + purpose, bytes); }
    finally { bytes.fill(0); }
  }
  private unpack<T>(purpose: string, body: Uint8Array): T {
    const bytes = openArchive(this.key, ENVELOPE + purpose, body);
    try { return JSON.parse(bytes.toString('utf8')); }
    finally { bytes.fill(0); }
  }
  private state(): DatabaseState {
    const row = this.sql('SELECT body FROM metadata WHERE id=1').get();
    if (!(row?.body instanceof Uint8Array)) throw new Error('Unreadable history archive');
    return this.unpack('state', row.body);
  }
  private save(state: DatabaseState) {
    this.sql('INSERT INTO metadata(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(this.pack('state', state));
  }
  private openRow(row: Row): Stored { return this.unpack('entry:' + row.token, row.body); }

  put(input: ArchiveInput, period: HistoryPeriod): 'stored' | 'duplicate' | 'expired' | 'capacity' {
    const now = this.now();
    if (!input.id || input.id.length > 1024 || !Number.isSafeInteger(input.version) || input.version < 1 ||
        !validWindow(input.fromMs, input.toMs) || !validTime(input.anchorMs) || !validTime(input.availableAtMs) ||
        input.anchorMs > input.availableAtMs || input.availableAtMs > now || input.payload === undefined ||
        !PERIODS.includes(period)) throw new Error('Invalid archive record');
    if (now >= this.nextMaintenance) { this.prune(); this.nextMaintenance = now + 30_000; }
    const token = this.tag('id', input.id);
    return this.transaction(() => {
      const prior = this.sql('SELECT n,token,body FROM entries WHERE token=?').get(token) as Row | undefined;
      if (prior) {
        const value = this.openRow(prior);
        return 'record' in value && now < value.record.expiresAtMs ? 'duplicate' : 'expired';
      }
      const expiresAtMs = historyExpiry(input.anchorMs, period);
      if (expiresAtMs <= now) {
        const marker = duplicateMarker(input.anchorMs, now);
        return marker && !this.insert(token, marker) ? 'capacity' : 'expired';
      }
      const record: ArchiveRecord = {id: input.id, version: input.version, fromMs: input.fromMs, toMs: input.toMs,
        anchorMs: input.anchorMs, availableAtMs: input.availableAtMs, payload: input.payload, expiresAtMs, period};
      return this.insert(token, {record}) ? 'stored' : 'capacity';
    });
  }

  private insert(token: string, value: Stored) {
    const record = 'record' in value ? value.record : undefined;
    const dueDay = 'forgetDay' in value ? value.forgetDay : dayOf(value.record.expiresAtMs);
    const body = this.pack('entry:' + token, value);
    const bytes = cost(body, record ? 2 * intervalDays(record) : 0);
    const state = this.state();
    if (body.length > MAX_PAYLOAD_BYTES || state.bytes + bytes > this.maxBytes || state.count >= this.maxRecords) {
      if (!state.capacityOmitted) { state.capacityOmitted = true; this.save(state); }
      return false;
    }
    const {lastInsertRowid} = this.sql('INSERT INTO entries(token,due,body) VALUES(?,?,?)').run(token, this.tag('due', dueDay), body);
    if (record) {
      const index = this.sql('INSERT INTO days(bucket,n) VALUES(?,?)');
      const hour = Math.floor(record.fromMs / HOUR);
      const singleHour = hour === Math.floor((record.toMs - 1) / HOUR);
      for (let day = dayOf(record.fromMs); day <= dayOf(record.toMs - 1); day++) {
        index.run(this.tag('day', day), lastInsertRowid);
        index.run(singleHour ? this.tag('hour', hour) : this.tag('spanning', day), lastInsertRowid);
      }
    }
    state.count++;
    state.bytes += bytes;
    addDueDay(state, dueDay);
    this.save(state);
    return true;
  }

  /** Rows are grouped by the first overlapping UTC day, then admission order.
   * Exact source times remain in each result. Each continuation has a fixed
   * high-water mark; filtered or expired rows also count toward the work bound. */
  read(query: ArchiveQuery): {records: ArchiveRecord[]; nextCursor: string | null; capacityOmitted: boolean} {
    return this.transaction(() => this.readPage(query), 'BEGIN');
  }
  private readPage(query: ArchiveQuery) {
    const limit = query.limit ?? 50;
    if (!validWindow(query.fromMs, query.toMs) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (query.knownAtMs !== undefined && !validTime(query.knownAtMs))) throw new Error('Invalid archive window');
    const state = this.state();
    const first = dayOf(query.fromMs);
    const last = dayOf(query.toMs - 1);
    const scope = {generation: state.generation, from: query.fromMs, to: query.toMs, known: query.knownAtMs ?? null, limit};
    let position: PageCursor;
    if (query.cursor !== undefined) {
      if (!query.cursor || query.cursor.length > 2048) throw new Error('Invalid archive cursor');
      position = this.unpack<PageCursor>('page', Buffer.from(query.cursor, 'base64url'));
      if (position.generation !== scope.generation || position.from !== scope.from || position.to !== scope.to ||
          position.known !== scope.known || position.limit !== limit || !Number.isSafeInteger(position.high) ||
          !Number.isSafeInteger(position.after) || position.after < 0 || position.after > position.high ||
          !Number.isInteger(position.day) || position.day < first || position.day > last) throw new Error('Invalid archive cursor');
    } else {
      const high = Number(this.sql('SELECT COALESCE(MAX(n),0) AS n FROM entries').get()!.n);
      position = {...scope, high, day: first, after: 0};
    }
    const records: ArchiveRecord[] = [];
    const result = (more: boolean) => ({records, nextCursor: more ? this.pack('page', position).toString('base64url') : null, capacityOmitted: state.capacityOmitted});
    const hour = Math.floor(query.fromMs / HOUR);
    const singleHour = hour === Math.floor((query.toMs - 1) / HOUR);
    let inspected = 0, bytes = 0;
    const now = this.now();
    while (position.day <= last) {
      const remaining = MAX_INSPECT - inspected + 1;
      // A short question on a busy day skips observations from unrelated hours.
      // The second seek still includes intervals that span the requested hour.
      const rows = singleHour
        ? this.sql(selectBucket + ' UNION ALL ' + selectBucket + ' ORDER BY n LIMIT ?').iterate(
          this.tag('hour', hour), position.after, position.high,
          this.tag('spanning', position.day), position.after, position.high, remaining)
        : this.sql(selectBucket + ' ORDER BY n LIMIT ?').iterate(this.tag('day', position.day), position.after, position.high, remaining);
      for (const item of rows) {
        if (inspected === MAX_INSPECT) return result(true);
        const row = item as Row;
        const data = this.openRow(row);
        inspected++;
        if (!('record' in data)) throw new Error('Invalid archive index');
        const r = data.record;
        if (position.day === Math.max(first, dayOf(r.fromMs)) && r.fromMs < query.toMs && r.toMs > query.fromMs &&
            r.expiresAtMs > now && (scope.known === null || r.availableAtMs <= scope.known)) {
          if (records.length >= limit || bytes + row.body.length > MAX_PAGE_BYTES) return result(true);
          records.push(r);
          bytes += row.body.length;
        }
        position.after = row.n;
      }
      position.day++;
      position.after = 0;
    }
    return result(false);
  }

  /** Purge exact deadlines in bounded batches. A keyed duplicate marker lives
   * until the original anchor could no longer qualify under any supported
   * period. The surviving marker contains no original fields, times or ID. */
  prune(maxEntries = 256) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) throw new Error('Invalid archive maintenance limit');
    const now = this.now(), today = dayOf(now);
    return this.transaction(() => {
      const state = this.state();
      let inspected = 0, removed = 0, changed = false;
      for (const day of [...state.dueDays]) {
        if (day > today || inspected >= maxEntries) break;
        const bucket = this.tag('due', day);
        const after = state.sweep?.day === day ? state.sweep.after : 0;
        const remaining = maxEntries - inspected;
        const rows = this.sql('SELECT n,token,body FROM entries WHERE due=? AND n>? ORDER BY n LIMIT ?').all(bucket, after, remaining) as Row[];
        for (const row of rows) {
          const value = this.openRow(row);
          const live = 'record' in value;
          const deadline = live ? value.record.expiresAtMs : value.forgetDay * DAY;
          if (dayOf(deadline) !== day) throw new Error('Invalid archive deadline index');
          if (deadline <= now) {
            const marker = live ? duplicateMarker(value.record.anchorMs, now) : undefined;
            state.bytes -= cost(row.body, live ? 2 * intervalDays(value.record) : 0);
            if (marker) {
              const body = this.pack('entry:' + row.token, marker);
              this.sql('DELETE FROM days WHERE n=?').run(row.n);
              this.sql('UPDATE entries SET body=?,due=? WHERE n=?').run(body, this.tag('due', marker.forgetDay), row.n);
              state.bytes += cost(body, 0);
              addDueDay(state, marker.forgetDay);
            } else {
              this.sql('DELETE FROM entries WHERE n=?').run(row.n);
              state.count--;
            }
            removed++;
          }
        }
        inspected += rows.length;
        changed = true;
        if (rows.length === remaining) { state.sweep = {day, after: rows[rows.length - 1].n}; break; }
        state.sweep = null;
        if (!this.sql('SELECT 1 FROM entries WHERE due=? LIMIT 1').get(bucket)) state.dueDays = state.dueDays.filter(d => d !== day);
      }
      if (changed) this.save(state);
      return removed;
    });
  }

  clear() {
    this.transaction(() => {
      this.db.exec("DELETE FROM entries; DELETE FROM sqlite_sequence WHERE name='entries'");
      this.save(initial());
    });
  }
  close() {
    this.statements.clear();
    this.key.fill(0);
    this.indexKey.fill(0);
    this.db.close();
  }
}
