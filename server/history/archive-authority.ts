import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { openArchive, sealArchive } from './archive-crypto.ts';
import type { ArchiveKeyProvider } from './archive-key.ts';
import { HistoryArchiveStore, type ArchiveInput, type ArchiveQuery, type ArchiveRecord } from './archive-store.ts';
import type { LocationContinuity, LocationTransaction } from './location-continuity.ts';
import type { HistoryPeriod } from './retention.ts';

// Health keeps its separately authorized key and is never opened by this authority.
export const archiveSources = ['location', 'weather', 'mobility'] as const;
export type ArchiveSource = typeof archiveSources[number];
const source = z.enum(archiveSources);
const period = z.enum(['7d', '1m', '6m', '1y']);
const ownerId = z.string().regex(/^[a-f0-9]{64}$/);
const grant = z.object({
  enabled: z.boolean(), stamp: z.uuid(), generation: z.uuid(), key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  locationContinuity: z.object({erased: z.string().regex(/^[a-f0-9]{32}$/), stopped: z.string().regex(/^[a-f0-9]{32}$/)}).strict().optional(),
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
type Options = {ownerStatus: (owner: string) => 'authorized' | 'unavailable' | 'revoked'; now?: () => number; locationContinuity?: () => LocationContinuity | undefined};
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
  private initial: string = randomUUID();
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

  private view(state: Policy, owner: string, committedMarker?: LocationContinuity) {
    if (!this.active(owner) || (state.owner && state.owner !== owner)) throw denied();
    let epoch = state.epoch;
    if (this.options.locationContinuity) {
      const mark = committedMarker ?? this.options.locationContinuity();
      const hash = createHash('sha256').update(JSON.stringify([state.epoch, mark?.revision, mark?.erased, mark?.stopped])).digest();
      hash[6] = (hash[6] & 0x0f) | 0x80;
      hash[8] = (hash[8] & 0x3f) | 0x80;
      const hex = hash.toString('hex');
      epoch = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
    }
    return {epoch, period: state.period, sources: {
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
      const continuity = this.options.locationContinuity?.();
      if (continuity) this.reconcileLocation(continuity);
      if (this.needsCleanup) this.collect();
    }
  }

  async status(owner: string) {
    if (!this.active(owner)) throw denied();
    await this.restore();
    return this.view(this.state(), owner);
  }

  /** The separately encrypted Polar archive uses the same owner-selected period.
   * No health category, account identity, archive key or record enters this store. */
  periodFor(owner: string, epoch?: string): HistoryPeriod | undefined {
    try {
      const state = this.state();
      if (state.owner !== owner) return;
      const current = this.view(state, owner);
      return !epoch || current.epoch === epoch ? current.period : undefined;
    } catch { return undefined; }
  }

  async bindPeriod(owner: string, epoch: string) {
    const before = await this.status(owner);
    if (before.epoch !== epoch) throw denied();
    await this.unlock(true);
    this.transaction(() => {
      const state = this.state();
      if (this.view(state, owner).epoch !== epoch) throw denied();
      if (!state.owner) { state.owner = owner; this.save(state); }
    });
  }

  /** Both durable files use SQLite's rollback journal. On the common panel,
   * the old-client consent and protected grant commit in one transaction. */
  private controlTransaction<T>(location: LocationTransaction | undefined, run: () => T) {
    if (!location) return this.transaction(run);
    this.db.prepare('ATTACH DATABASE ? AS legacy_history').run(location.path);
    try {
      for (const schema of ['main', 'legacy_history']) {
        if (this.db.prepare(`PRAGMA ${schema}.journal_mode`).get()?.journal_mode !== 'delete') throw unavailable();
      }
      this.db.exec('PRAGMA legacy_history.synchronous=FULL; PRAGMA legacy_history.secure_delete=ON');
      const result = this.transaction(run);
      location.committed();
      return result;
    } finally { this.db.exec('DETACH DATABASE legacy_history'); }
  }

  async control(owner: string, epoch: string, raw: z.infer<typeof change>, location?: LocationTransaction) {
    const input = change.parse(raw);
    if (location && (input.action === 'period' || input.source !== 'location')) throw denied();
    const displayed = await this.status(owner);
    if (displayed.epoch !== epoch) throw denied();
    if (!this.row() && (input.action === 'set' && input.enabled || input.action === 'period' && input.period !== '7d'))
      await this.unlock(true);
    const result = this.controlTransaction(location, () => {
      const state = this.state();
      const before = this.view(state, owner);
      if (before.epoch !== epoch) throw denied();
      const paired = location?.apply(this.db);
      const unchanged = (input.action === 'period' && state.period === input.period) ||
          (input.action === 'set' && before.sources[input.source] === input.enabled) ||
          (input.action === 'delete' && !state.sources[input.source]);
      if (unchanged) {
        if (paired?.changed) {
          state.epoch = randomUUID();
          if (this.row()) this.save(state);
          else this.initial = state.epoch;
        }
        return this.view(state, owner, paired?.marker);
      }
      state.owner = owner;
      state.epoch = randomUUID();
      if (input.action === 'period') {
        state.period = input.period;
        const now = (this.options.now ?? Date.now)();
        for (const g of Object.values(state.sources)) { g.stamp = randomUUID(); g.since = now; }
      } else if (input.action === 'delete') {
        delete state.sources[input.source];
      } else {
        const marker = input.source === 'location' ? paired?.marker ?? this.options.locationContinuity?.() : undefined;
        if (input.source === 'location' && input.enabled && this.options.locationContinuity && !marker) throw unavailable();
        const existing = state.sources[input.source];
        const g = existing ?? {key: randomBytes(32).toString('base64'), generation: randomUUID()};
        if (!existing) {
          this.needsCleanup = true;
          const key = Buffer.from(g.key, 'base64');
          try { new HistoryArchiveStore(this.path(g.generation), key, this.options).close(); }
          finally { key.fill(0); }
        }
        state.sources[input.source] = {...g, ...(marker ? {locationContinuity:{erased:marker.erased, stopped:marker.stopped}} : {}), enabled: input.enabled, stamp: randomUUID(), since: (this.options.now ?? Date.now)()};
      }
      this.save(state);
      return this.view(state, owner, paired?.marker);
    });
    if (input.action === 'delete') this.collect();
    // The legacy epoch renews synchronously after both files commit.
    return location ? this.view(this.state(), owner) : result;
  }

  async revoke(owner: string) {
    if (!ownerId.safeParse(owner).success || this.options.ownerStatus(owner) !== 'revoked') throw denied();
    await this.unlock(false);
    this.transaction(() => {
      if (this.state().owner === owner && this.options.ownerStatus(owner) === 'revoked') this.save(fresh(randomUUID()));
    });
    this.collect();
  }

  /** The live legacy database can also be changed by an older app, which knows
   * only its seven-day consent. Reconcile before showing or using the extension. */
  reconcileLocation(mark: LocationContinuity) {
    const needsCheck = (g: NonNullable<Policy['sources']['location']>) =>
      g.locationContinuity?.erased !== mark.erased || g.locationContinuity.stopped !== mark.stopped;
    const existing = this.state().sources.location;
    if (!existing || !needsCheck(existing)) return;
    const removed = this.transaction(() => {
      const current = this.state(), g = current.sources.location;
      if (!g || !needsCheck(g)) return false;
      const previous = g.locationContinuity;
      if (previous && previous.erased !== mark.erased) {
        delete current.sources.location;
        current.epoch = randomUUID();
        this.save(current);
        return true;
      }
      if (previous && g.enabled) {
        g.enabled = false;
        g.stamp = randomUUID();
        current.epoch = randomUUID();
      }
      g.locationContinuity = {erased:mark.erased, stopped:mark.stopped};
      this.save(current);
      return false;
    });
    if (removed) this.collect();
  }

  private ensureLocationAccess(source: ArchiveSource) {
    if (source !== 'location' || !this.options.locationContinuity) return;
    const mark = this.options.locationContinuity();
    if (!mark) throw unavailable();
    this.reconcileLocation(mark);
  }

  historyOwner(source: ArchiveSource): string | undefined {
    try {
      this.ensureLocationAccess(source);
      const state = this.state();
      const grant = state.sources[source];
      if (state.owner && grant?.enabled && grant.since !== undefined && this.active(state.owner)) return state.owner;
    } catch { /* Locked, missing or corrupt authority cannot authorize history. */ }
  }

  capture(owner: string, source: ArchiveSource): ArchiveLease | undefined {
    if (!this.active(owner)) return;
    this.ensureLocationAccess(source);
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
    this.ensureLocationAccess(lease.source);
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
  updatePayload(lease: ArchiveLease, id: string, edit: (record: ArchiveRecord) => unknown) {
    return this.withStore(lease, store => store.updatePayload(id, edit));
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
