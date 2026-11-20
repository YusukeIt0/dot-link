import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { openArchive, sealArchive } from '../history/archive-crypto.ts';
import { historyExpiry, type HistoryPeriod } from '../history/retention.ts';
import { categories, observationSchema, type Category, type Observation } from './data.ts';
import { polarHistoryInterval } from './history.ts';

const DAY = 86_400_000, WEEK = 7 * DAY;
const PAGE = 1024 * 1024, INDEX = 1024 * 1024, SLOTS = 80;
const prefix = 'dot-link:polar-history:v1:';
const invalid = () => new Error('POLAR_HISTORY_UNAVAILABLE');

export interface RetainedPolarObservation {
  observation: Observation;
  firstReceivedMs: number;
  anchorMs: number;
  expiresAtMs: number;
  period: HistoryPeriod;
}
type Entry = RetainedPolarObservation | {forgetAt: number};
type Contents = Record<string, Entry>;
type Partition = {week: number; revision: string; used: number; from: number | null; to: number | null; due: number};
type Catalog = {
  identity: string; revision: string; slotById: Record<string, number>; partitions: (Partition | null)[];
  // Merge losses conservatively per metric family without persisting unbounded identities.
  gaps: Partial<Record<Category, {from: number; to: number; through: number}>>;
};
type Options = {create?: boolean; now?: () => number; slots?: number; pageBytes?: number; indexBytes?: number};
export type PolarArchiveQuery = {startMs: number; endMs: number; categories?: readonly Category[]; limit?: number; cursor?: string};
type PageCursor = {revision: string; query: string; slot: number; offset: number; expires: number};
const frameSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) + 4;
const entrySize = (id: string, value: Entry) => id.length + Buffer.byteLength(JSON.stringify(value)) + 4;
const validTime = (time: number) => Number.isSafeInteger(time) && Math.abs(time) <= 8.64e15;
const safePeriod = (p: HistoryPeriod) => ['7d','1m','6m','1y'].includes(p);

function frame(key: Buffer, domain: string, size: number, value: unknown) {
  const content = Buffer.from(JSON.stringify(value));
  const padded = Buffer.alloc(size);
  try {
    if (content.length > size - 4) throw invalid();
    padded.writeUInt32LE(content.length);
    content.copy(padded, 4);
    return sealArchive(key, prefix + domain, padded);
  } finally { content.fill(0); padded.fill(0); }
}
function unframe<T>(key: Buffer, domain: string, size: number, bytes: Uint8Array) {
  if (bytes.length !== size + 29) throw invalid();
  const plain = openArchive(key, prefix + domain, bytes);
  try {
    const length = plain.readUInt32LE();
    if (length > size - 4) throw invalid();
    return JSON.parse(plain.toString('utf8', 4, 4 + length)) as T;
  } finally { plain.fill(0); }
}
function updateBounds(partition: Partition, entries: Contents) {
  partition.from = null; partition.to = null; partition.due = Number.MAX_SAFE_INTEGER;
  for (const item of Object.values(entries)) {
    if ('forgetAt' in item) { partition.due = Math.min(partition.due, item.forgetAt); continue; }
    partition.due = Math.min(partition.due, item.expiresAtMs);
    const interval = polarHistoryInterval(item.observation);
    if (interval) {
      partition.from = Math.min(partition.from ?? Infinity, interval.from);
      partition.to = Math.max(partition.to ?? -Infinity, interval.to);
    }
  }
}
const marker = (anchor: number, now: number) => {
  const forgetAt = Math.ceil(historyExpiry(anchor, '1y') / DAY) * DAY;
  return forgetAt > now ? {forgetAt} : undefined;
};

/** The caller supplies a separate generation key under the health grant and
 * retires it on erasure. A snapshot shows a fixed number of equally sized
 * encrypted data pages and one padded encrypted catalog. Only the catalog
 * maps opaque slots to weeks, metrics, identities and actual occupancy. */
export class PolarHistoryArchive {
  private readonly key: Buffer;
  private readonly db: DatabaseSync;
  private readonly slots: number;
  private readonly pageBytes: number;
  private readonly indexBytes: number;
  private readonly now: () => number;

  constructor(path: string, generationKey: Buffer, options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.slots = options.slots ?? SLOTS;
    this.pageBytes = options.pageBytes ?? PAGE;
    this.indexBytes = options.indexBytes ?? INDEX;
    if (generationKey.length !== 32 || !Number.isInteger(this.slots) || this.slots < 1 || this.slots > 256 ||
        ![this.pageBytes, this.indexBytes].every(n => Number.isInteger(n) && n >= 2048 && n <= 4 * PAGE)) throw invalid();
    const directory = dirname(path);
    if (options.create) mkdirSync(directory, {recursive: true, mode: 0o700});
    const info = lstatSync(directory);
    if (!info.isDirectory() || (info.mode & 0o077)) throw invalid();
    for (const file of [path, path + '-journal', path + '-wal', path + '-shm']) {
      const fileInfo = lstatSync(file, {throwIfNoEntry: false});
      if (fileInfo && (!fileInfo.isFile() || fileInfo.nlink !== 1)) throw invalid();
    }
    const flags = constants.O_NOFOLLOW | constants.O_RDWR | (options.create ? constants.O_CREAT : 0);
    closeSync(openSync(path, flags, 0o600));
    chmodSync(path, 0o600);
    this.key = Buffer.from(generationKey);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
      this.transaction(true, () => {
        const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
        if (version === 1) { this.catalog(); return; }
        if (version !== 0 || !options.create || this.db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) throw invalid();
        this.db.exec('CREATE TABLE pages (slot INTEGER PRIMARY KEY, body BLOB NOT NULL) STRICT; PRAGMA user_version=1');
        const insert = this.db.prepare('INSERT INTO pages VALUES(?,?)');
        const catalog: Catalog = {identity: randomUUID(), revision: randomUUID(), slotById: {}, partitions: Array(this.slots).fill(null), gaps: {}};
        insert.run(-1, frame(this.key, 'catalog', this.indexBytes, catalog));
        for (let slot = 0; slot < this.slots; slot++)
          insert.run(slot, frame(this.key, this.domain(catalog, slot), this.pageBytes, {}));
      });
    } catch (error) { this.close(); throw error; }
  }

  private transaction<T>(write: boolean, run: () => T) {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private bytes(slot: number) {
    const body = this.db.prepare('SELECT body FROM pages WHERE slot=?').get(slot)?.body;
    if (!(body instanceof Uint8Array)) throw invalid();
    return body;
  }
  private write(slot: number, body: Buffer) {
    if (this.db.prepare('UPDATE pages SET body=? WHERE slot=?').run(body, slot).changes !== 1) throw invalid();
  }
  private catalog() {
    const c = unframe<Catalog>(this.key, 'catalog', this.indexBytes, this.bytes(-1));
    if (c.partitions.length !== this.slots) throw invalid();
    return c;
  }
  private domain(c: Catalog, slot: number) { return c.identity + ':' + slot + ':' + (c.partitions[slot]?.revision ?? 'empty'); }
  private contents(c: Catalog, slot: number) {
    return unframe<Contents>(this.key, this.domain(c, slot), this.pageBytes, this.bytes(slot));
  }
  private flush(c: Catalog, dirty: Map<number, Contents>) {
    for (const [slot, entries] of dirty) {
      const p = c.partitions[slot];
      if (p && Object.keys(entries).length) {
        updateBounds(p, entries);
        p.revision = randomUUID();
      } else c.partitions[slot] = null;
      this.write(slot, frame(this.key, this.domain(c, slot), this.pageBytes, entries));
    }
    c.revision = randomUUID();
    this.write(-1, frame(this.key, 'catalog', this.indexBytes, c));
  }

  /** Batch one already-authorized fetch. A retry or correction keeps the
   * original policy, first receipt and exclusive deadline. */
  put(rows: readonly Observation[], period: HistoryPeriod) {
    if (rows.length > 4000 || !safePeriod(period)) throw invalid();
    const now = this.now();
    return this.transaction(true, () => {
      const c = this.catalog();
      const dirty = new Map<number, Contents>();
      const loaded = new Map<number, Contents>();
      const load = (slot: number) => {
        let entries = loaded.get(slot);
        if (!entries) { entries = this.contents(c, slot); loaded.set(slot, entries); }
        return entries;
      };
      const result = {stored: 0, corrected: 0, duplicate: 0, expired: 0, capacity: 0};
      let lossChanged = false;
      const omit = (category: Category, interval: {from:number; to:number}, through: number) => {
        const gap = c.gaps[category];
        const active = gap && historyExpiry(gap.through, '1y') > now ? gap : undefined;
        const next = {from: Math.min(active?.from ?? Infinity, interval.from), to: Math.max(active?.to ?? -Infinity, interval.to),
          through: Math.max(active?.through ?? -Infinity, through)};
        if (!active || active.from !== next.from || active.to !== next.to || active.through !== next.through) {
          c.gaps[category] = next;
          lossChanged = true;
        }
        result.capacity++;
      };
      // Fixed upper bound on catalog growth, including all slot summaries,
      // tombstone IDs, and numeric values at their maximum encoded length.
      const maxIds = Math.max(0, Math.floor((this.indexBytes - this.slots * 220 - 512) / 72));
      let idCount = Object.keys(c.slotById).length;
      for (const candidate of rows) {
        const parsed = observationSchema.safeParse(candidate);
        if (!parsed.success) throw invalid();
        const observation = parsed.data;
        const id = observation.id, received = Date.parse(observation.retrieved_at);
        const interval = polarHistoryInterval(observation);
        if (!/^[a-f0-9]{64}$/.test(id) || !validTime(received) || !validTime(observation.retention_anchor) ||
            received > now || observation.retention_anchor > now || !interval) throw invalid();
        const oldSlot = c.slotById[id];
        const previous = oldSlot === undefined ? undefined : load(oldSlot)[id];
        if (oldSlot !== undefined && !previous) throw invalid();
        if (previous && ('forgetAt' in previous || previous.expiresAtMs <= now)) { result.expired++; continue; }
        if (previous && received <= Date.parse(previous.observation.retrieved_at)) { result.duplicate++; continue; }
        const anchorMs = previous?.anchorMs ?? Math.min(observation.retention_anchor, received);
        const gap = c.gaps[observation.category];
        if (!previous && gap && historyExpiry(gap.through, '1y') > now && anchorMs <= gap.through) {
          omit(observation.category, interval, gap.through); continue;
        }
        const expiresAtMs = previous?.expiresAtMs ?? historyExpiry(anchorMs, period);
        const value: Entry | undefined = expiresAtMs <= now ? marker(anchorMs, now) : {
          observation, anchorMs, firstReceivedMs: previous?.firstReceivedMs ?? received, expiresAtMs, period: previous?.period ?? period,
        };
        if (!value) { result.expired++; continue; }
        const cost = entrySize(id, value), week = Math.floor(anchorMs / WEEK);
        let slot = oldSlot;
        const oldCost = previous ? entrySize(id, previous) : 0;
        if (slot === undefined || c.partitions[slot]!.used + cost - oldCost > this.pageBytes) {
          slot = c.partitions.findIndex(p => p && p.week === week && p.used + cost <= this.pageBytes);
          if (slot < 0) slot = c.partitions.indexOf(null);
        }
        if (cost + 6 > this.pageBytes || slot < 0 || (oldSlot === undefined && idCount >= maxIds)) {
          omit(observation.category, interval, now); continue;
        }
        const entries = load(slot);
        if (!c.partitions[slot]) c.partitions[slot] = {week, revision: '', used: 6, from: null, to: null, due: 0};
        if (oldSlot !== undefined && oldSlot !== slot) {
          const other = load(oldSlot);
          delete other[id]; c.partitions[oldSlot]!.used -= oldCost; dirty.set(oldSlot, other);
        }
        c.partitions[slot]!.used += cost - (oldSlot === slot ? oldCost : 0);
        if (oldSlot === undefined) idCount++;
        c.slotById[id] = slot; entries[id] = value; dirty.set(slot, entries);
        if ('forgetAt' in value) result.expired++;
        else if (!previous) result.stored++;
        else if (isDeepStrictEqual({...previous.observation, retrieved_at: observation.retrieved_at}, observation)) result.duplicate++;
        else result.corrected++;
      }
      if (dirty.size || lossChanged) this.flush(c, dirty);
      return result;
    });
  }

  read(query: PolarArchiveQuery) {
    const {startMs, endMs} = query, limit = query.limit ?? 50;
    const fields = [...new Set(query.categories ?? categories)].sort();
    if (!fields.length || fields.some(category => !categories.includes(category)) || !Number.isInteger(limit) || limit < 1 || limit > 80 ||
        !validTime(startMs) || !validTime(endMs) || endMs <= startMs || endMs - startMs > 366 * DAY) throw invalid();
    const now = this.now(), signature = JSON.stringify([startMs,endMs,fields,limit]);
    return this.transaction(false, () => {
      const c = this.catalog();
      const slots = c.partitions.map((p, slot) => ({p,slot})).filter(({p}) => p?.from != null && p.to != null && p.from < endMs && p.to > startMs)
        .sort((a,b) => b.p!.week - a.p!.week || a.slot - b.slot);
      let position: PageCursor = {revision: c.revision, query: signature, slot: 0, offset: 0, expires: now + 300_000};
      if (query.cursor) {
        if (query.cursor.length > 4096) throw invalid();
        const bytes = openArchive(this.key, prefix + 'cursor', Buffer.from(query.cursor, 'base64url'));
        try { position = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
        if (position.query !== signature || position.revision !== c.revision || position.expires <= now) throw invalid();
      }
      const records: RetainedPolarObservation[] = [];
      let totalBytes = 0, inspected = 0;
      while (position.slot < slots.length && inspected++ < 3 && records.length < limit) {
        const entries = Object.values(this.contents(c, slots[position.slot].slot)).filter((entry): entry is RetainedPolarObservation => 'observation' in entry)
          .sort((a,b) => b.anchorMs - a.anchorMs || a.observation.id.localeCompare(b.observation.id));
        while (position.offset < entries.length && records.length < limit) {
          const row = entries[position.offset], interval = polarHistoryInterval(row.observation)!;
          if (row.expiresAtMs > now && fields.includes(row.observation.category) && interval.from < endMs && interval.to > startMs) {
            const size = frameSize(row);
            if (records.length && totalBytes + size > PAGE) break;
            records.push(row); totalBytes += size;
            position.expires = Math.min(position.expires, row.expiresAtMs);
          }
          position.offset++;
        }
        if (position.offset < entries.length) break;
        position.slot++; position.offset = 0;
      }
      const nextCursor = position.slot < slots.length
        ? sealArchive(this.key, prefix + 'cursor', Buffer.from(JSON.stringify(position))).toString('base64url') : null;
      const capacityOmitted = fields.some(category => {
        const gap = c.gaps[category];
        return gap && historyExpiry(gap.through, '1y') > now && gap.from < endMs && gap.to > startMs;
      });
      return {records, nextCursor, capacityOmitted, validUntilMs: position.expires};
    });
  }

  prune(maxPages = Math.min(4, this.slots)) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > this.slots) throw invalid();
    const now = this.now();
    return this.transaction(true, () => {
      const c = this.catalog(), dirty = new Map<number, Contents>();
      let removed = 0;
      for (const [slot, p] of c.partitions.entries()) {
        if (!p || p.due > now) continue;
        const entries = this.contents(c, slot);
        for (const [id, item] of Object.entries(entries)) {
          const deadline = 'forgetAt' in item ? item.forgetAt : item.expiresAtMs;
          if (deadline > now) continue;
          p.used -= entrySize(id, item);
          const replacement = 'anchorMs' in item ? marker(item.anchorMs, now) : undefined;
          if (replacement) { entries[id] = replacement; p.used += entrySize(id, replacement); }
          else { delete entries[id]; delete c.slotById[id]; }
          removed++;
        }
        dirty.set(slot, entries);
        if (dirty.size === maxPages) break;
      }
      if (dirty.size) this.flush(c, dirty);
      return removed;
    });
  }

  close() { this.key.fill(0); this.db.close(); }
}
