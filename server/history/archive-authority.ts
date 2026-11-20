import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { openArchive, sealArchive } from './archive-crypto.ts';
import type { ArchiveKeyProvider } from './archive-key.ts';
import { HistoryArchiveStore, type ArchiveInput, type ArchiveQuery } from './archive-store.ts';
import type { HistoryPeriod } from './retention.ts';

// Health keeps its separately authorized key and is never opened by this authority.
export const archiveSources = ['location', 'weather', 'mobility'] as const;
export type ArchiveSource = typeof archiveSources[number];
const source = z.enum(archiveSources);
const period = z.enum(['7d', '1m', '6m', '1y']);
const ownerId = z.string().regex(/^[a-f0-9]{64}$/);
const grant = z.object({
  enabled: z.boolean(), stamp: z.uuid(), generation: z.uuid(), key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  since: z.number().int().nonnegative().optional(),
}).strict();
const policy = z.object({
  version: z.literal(1), owner: ownerId.nullable(), epoch: z.uuid(), period,
  sources: z.partialRecord(source, grant),
}).strict();
type Policy = z.infer<typeof policy>;
const change = z.discriminatedUnion('action', [
  z.object({action: z.literal('set'), source, enabled: z.boolean()}).strict(),
  z.object({action: z.literal('period'), period}).strict(),
  z.object({action: z.literal('delete'), source}).strict(),
]);
export type ArchiveLease = {readonly owner: string; readonly source: ArchiveSource; readonly stamp: string; readonly since: number};
type Row = {wrapped: string; sealed: Uint8Array};
type Options = {ownerStatus: (owner: string) => 'authorized' | 'unavailable' | 'revoked'; now?: () => number};
const aad = 'dot-link:history:archive-authority:v1';
const denied = () => new Error('HISTORY_ARCHIVE_ACCESS_CHANGED');
const unavailable = () => new Error('HISTORY_ARCHIVE_UNAVAILABLE');
const fresh = (epoch: string): Policy => ({version: 1, owner: null, epoch, period: '7d', sources: {}});

/** The current grants and generation keys live separately from replaceable evidence files.
 * Restoring an old evidence file cannot put its key back into this authority. */
export class ArchiveAuthority {
  private db: DatabaseSync;
  private provider: ArchiveKeyProvider;
  private options: Options;
  private records: string;
  private needsCleanup = true;
  private initial = randomUUID();
  private unlocked?: {key: Buffer; wrapped: string};
  private closed = false;

  constructor(directory: string, provider: ArchiveKeyProvider, options: Options) {
    mkdirSync(directory, {mode: 0o700, recursive: true});
    if (!lstatSync(directory).isDirectory()) throw unavailable();
    chmodSync(directory, 0o700);
    const path = join(directory, 'authority.sqlite');
    this.records = join(directory, 'sources');
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const sidecar = lstatSync(path + suffix, {throwIfNoEntry: false});
      if (sidecar && (!sidecar.isFile() || sidecar.nlink !== 1)) throw unavailable();
    }
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1) throw unavailable();
    chmodSync(path, 0o600);
    this.provider = provider;
    this.options = options;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS authority (id INTEGER PRIMARY KEY CHECK(id=1), wrapped TEXT NOT NULL, sealed BLOB NOT NULL) STRICT');
    } catch (error) { this.db.close(); throw error; }
  }

  private row() {
    if (this.closed) throw unavailable();
    return this.db.prepare('SELECT wrapped, sealed FROM authority WHERE id=1').get() as Row | undefined;
  }

  private encode(state: Policy, key: Buffer) {
    const plain = Buffer.from(JSON.stringify(state));
    try { return sealArchive(key, aad, plain); } finally { plain.fill(0); }
  }

  private decode(row: Row, key: Buffer): Policy {
    if (row.sealed.length > 16_384) throw unavailable();
    const bytes = openArchive(key, aad, row.sealed);
    try { return policy.parse(JSON.parse(bytes.toString('utf8'))); } finally { bytes.fill(0); }
  }

  private state(): Policy {
    const row = this.row();
    if (!row) return fresh(this.initial);
    if (!this.unlocked || this.unlocked.wrapped !== row.wrapped) throw unavailable();
    return this.decode(row, this.unlocked.key);
  }

  private async unlock(create: boolean) {
    const row = this.row();
    if (!row && !create) return;
    if (row && this.unlocked?.wrapped === row.wrapped) return;
    const material = row ? {key: await this.provider.open(row.wrapped), wrapped: row.wrapped} : await this.provider.create();
    try {
      if (this.closed || material.key.length !== 32) throw unavailable();
      if (!row) {
        const blank = this.encode(fresh(this.initial), material.key);
        this.db.prepare('INSERT OR IGNORE INTO authority VALUES(1,?,?)').run(material.wrapped, blank);
      }
      const actual = this.row();
      if (!actual || actual.wrapped !== material.wrapped) throw denied();
      this.decode(actual, material.key);
      this.unlocked?.key.fill(0);
      this.unlocked = {key: Buffer.from(material.key), wrapped: material.wrapped};
    } finally { material.key.fill(0); }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private save(state: Policy) {
    const material = this.unlocked;
    if (!material) throw unavailable();
    const sealed = this.encode(state, material.key);
    if (!this.db.prepare('UPDATE authority SET sealed=? WHERE id=1 AND wrapped=?').run(sealed, material.wrapped).changes) throw denied();
  }

  private active(owner: string) {
    return ownerId.safeParse(owner).success && this.options.ownerStatus(owner) === 'authorized';
  }

  private view(state: Policy, owner: string) {
    if (!this.active(owner) || (state.owner && state.owner !== owner)) throw denied();
    return {epoch: state.epoch, period: state.period, sources: {
      location: state.sources.location?.enabled ?? false,
      weather: state.sources.weather?.enabled ?? false,
      mobility: state.sources.mobility?.enabled ?? false,
    }};
  }

  // Only collect retired files after authenticating the current grants. Run again
  // on reopening if the relay stopped after committing deletion and before unlink.
  private collect() {
    this.needsCleanup = true;
    this.transaction(() => {
      if (!this.row()) return;
      const live = new Set(Object.values(this.state().sources).map(g => g.generation));
      const dir = lstatSync(this.records, {throwIfNoEntry: false});
      if (!dir) return;
      if (!dir.isDirectory()) throw unavailable();
      for (const name of readdirSync(this.records)) {
        const match = /^([a-f0-9-]{36})\.sqlite(?:-(?:shm|wal|journal))?$/.exec(name);
        if (match && !live.has(match[1])) unlinkSync(join(this.records, name));
      }
    });
    this.needsCleanup = false;
  }

  async restore() {
    await this.unlock(false);
    const state = this.state();
    if (state.owner && this.options.ownerStatus(state.owner) === 'revoked') await this.revoke(state.owner);
    else {
      // Old grants already authorize their stored rows. Set an acquisition
      // boundary once so an older cache cannot be mistaken for new evidence.
      if (Object.values(state.sources).some(g => g.since === undefined)) this.transaction(() => {
        const current = this.state();
        const now = (this.options.now ?? Date.now)();
        for (const g of Object.values(current.sources)) g.since ??= now;
        this.save(current);
      });
      if (this.needsCleanup) this.collect();
    }
  }

  async status(owner: string) {
    if (!this.active(owner)) throw denied();
    await this.restore();
    return this.view(this.state(), owner);
  }

  async control(owner: string, epoch: string, raw: z.infer<typeof change>) {
    const input = change.parse(raw);
    const displayed = await this.status(owner);
    if (displayed.epoch !== epoch) throw denied();
    if (!this.row() && (input.action === 'set' && input.enabled || input.action === 'period' && input.period !== '7d'))
      await this.unlock(true);
    const result = this.transaction(() => {
      const state = this.state();
      const before = this.view(state, owner);
      if (state.epoch !== epoch) throw denied();
      if ((input.action === 'period' && state.period === input.period) ||
          (input.action === 'set' && before.sources[input.source] === input.enabled) ||
          (input.action === 'delete' && !state.sources[input.source])) return before;
      state.owner = owner;
      state.epoch = randomUUID();
      if (input.action === 'period') {
        state.period = input.period;
        const now = (this.options.now ?? Date.now)();
        for (const g of Object.values(state.sources)) { g.stamp = randomUUID(); g.since = now; }
      } else if (input.action === 'delete') {
        delete state.sources[input.source];
      } else {
        const existing = state.sources[input.source];
        const g = existing ?? {key: randomBytes(32).toString('base64'), generation: randomUUID()};
        if (!existing) {
          const key = Buffer.from(g.key, 'base64');
          try { new HistoryArchiveStore(this.path(g.generation), key, this.options).close(); }
          finally { key.fill(0); }
        }
        state.sources[input.source] = {...g, enabled: input.enabled, stamp: randomUUID(), since: (this.options.now ?? Date.now)()};
      }
      this.save(state);
      return this.view(state, owner);
    });
    if (input.action === 'delete') this.collect();
    return result;
  }

  async revoke(owner: string) {
    if (!ownerId.safeParse(owner).success || this.options.ownerStatus(owner) !== 'revoked') throw denied();
    await this.unlock(false);
    this.transaction(() => {
      if (this.state().owner === owner && this.options.ownerStatus(owner) === 'revoked') this.save(fresh(randomUUID()));
    });
    this.collect();
  }

  historyOwner(source: ArchiveSource): string | undefined {
    try {
      const state = this.state();
      const grant = state.sources[source];
      if (state.owner && grant?.enabled && grant.since !== undefined && this.active(state.owner)) return state.owner;
    } catch { /* Locked, missing or corrupt authority cannot authorize history. */ }
  }

  capture(owner: string, source: ArchiveSource): ArchiveLease | undefined {
    if (!this.active(owner)) return;
    const state = this.state();
    const g = state.sources[source];
    if (state.owner === owner && g?.enabled && g.since !== undefined) return {owner, source, stamp: g.stamp, since: g.since};
  }

  allows(lease: ArchiveLease): boolean {
    try {
      const current = this.capture(lease.owner, lease.source);
      return current?.stamp === lease.stamp && current.since === lease.since;
    }
    catch { return false; }
  }

  /** Synchronous read/write under the current policy. Never cache the key or the store outside this call. */
  use<T>(lease: ArchiveLease, run: (key: Buffer, generation: string, period: HistoryPeriod) => T): T {
    return this.transaction(() => {
      const state = this.state();
      const g = state.sources[lease.source];
      if (state.owner !== lease.owner || !this.active(lease.owner) || !g?.enabled || g.stamp !== lease.stamp || g.since !== lease.since)
        throw denied();
      const key = Buffer.from(g.key, 'base64');
      try {
        const result = run(key, g.generation, state.period);
        if (!this.active(lease.owner)) throw denied();
        return result;
      } finally { key.fill(0); }
    });
  }

  private path(generation: string) { return join(this.records, generation + '.sqlite'); }

  private existingStore(key: Buffer, generation: string) {
    const path = this.path(generation);
    // Missing evidence after enrollment is a storage fault. Never substitute an empty database.
    const info = lstatSync(path, {throwIfNoEntry: false});
    if (!info?.isFile() || info.size === 0) throw unavailable();
    return new HistoryArchiveStore(path, key, {...this.options, existingOnly: true});
  }

  async maintain() {
    await this.restore();
    this.transaction(() => {
      // Stopped archives age even if the client and the provider never reconnect.
      let failed = false;
      for (const g of Object.values(this.state().sources)) {
        const key = Buffer.from(g.key, 'base64');
        try {
          const store = this.existingStore(key, g.generation);
          try { store.prune(128); } finally { store.close(); }
        } catch { failed = true; }
        finally { key.fill(0); }
      }
      if (failed) throw unavailable();
    });
  }

  private withStore<T>(lease: ArchiveLease, run: (store: HistoryArchiveStore, period: HistoryPeriod) => T) {
    return this.use(lease, (key, generation, period) => {
      const store = this.existingStore(key, generation);
      try { return run(store, period); } finally { store.close(); }
    });
  }

  put(lease: ArchiveLease, record: ArchiveInput) {
    if (record.availableAtMs < lease.since) return 'before_grant' as const;
    return this.withStore(lease, (store, period) => store.put(record, period));
  }
  read(lease: ArchiveLease, query: ArchiveQuery) { return this.withStore(lease, store => store.read(query)); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unlocked?.key.fill(0);
    this.unlocked = undefined;
    this.db.close();
  }
}
