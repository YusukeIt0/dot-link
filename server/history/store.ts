import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChangeSignal } from '../changes.ts';
import { ToolRejection } from '../tool-response.ts';
import type { LocationFix } from '../../src/location-fix.ts';
import type { GeographicEvidence } from '../geography/types.ts';
import { geographicEvidence } from '../geography/geometry.ts';
import { historyFixture, historyGeography, historyScenarios } from './fixtures.ts';
import { HISTORY_RETENTION_MS, LocationHistoryIndex, historyObservationSchema, type HistoryEntry } from './replay.ts';

const MAXIMUM = 50_000;
const consentSchema = z.object({ version: z.literal(1), owner: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  enabled: z.boolean(), capacityOmitted: z.boolean().default(false), consentAt: z.number().finite(), recordingEpoch: z.number().int().nonnegative(),
  lastSession: z.string().optional(), scenario: z.enum(historyScenarios).nullable(), reference: z.number().finite().nullable() });
type Consent = z.infer<typeof consentSchema>;
const controlSchema = z.object({ protocol: z.literal(1), epoch: z.string().uuid(),
  action: z.enum(['enable', 'disable', 'delete', 'simulate', 'finish_simulation']), scenario: z.enum(historyScenarios).optional() }).strict();
export const historyUploadSchema = z.object({ protocol: z.literal(1), epoch: z.string().uuid(),
  timezone: z.string().max(80).optional(), utc_offset_minutes: z.number().int().min(-840).max(840).optional() }).strict();
const failure = () => new ToolRejection('history_access_changed', 'Historical access changed. Continue the conversation using authorized context; do not resend a stale historical answer.');
const emptyConsent = (): Consent => ({version: 1, enabled: false, capacityOmitted: false, consentAt: 0, recordingEpoch: 0, scenario: null, reference: null});

/** One SQLite owner per Mac. App updates replace code, never this data directory. */
export class LocationHistoryStore {
  readonly changes = new ChangeSignal();
  private db: DatabaseSync;
  private consent: Consent;
  private epoch = randomUUID();
  private index: LocationHistoryIndex;
  private geography = new Map<string, GeographicEvidence>();
  private reads = new Map<string, {epoch: string; expires: number}>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private healthy = true;
  private dirty = false;
  private now: () => number;
  private ownerAuthorized: (owner: string) => boolean;
  private beta: boolean;
  private announce: (input: {message_id: string; text: string; utterance_id: string}, guard: () => boolean) => Promise<unknown>;
  constructor(directory: string, options: {now?: () => number; beta?: boolean; ownerAuthorized: (owner: string) => boolean;
    announce: (input: {message_id: string; text: string; utterance_id: string}, guard: () => boolean) => Promise<unknown>}) {
    this.now = options.now ?? Date.now; this.beta = options.beta === true;
    this.ownerAuthorized = options.ownerAuthorized; this.announce = options.announce;
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Invalid history directory');
    chmodSync(directory, 0o700);
    const path = join(directory, 'history.sqlite');
    try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid history file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA max_page_count=65536;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version);
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported history schema'); }
    this.db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, measured INTEGER NOT NULL, data TEXT NOT NULL, geography TEXT); CREATE INDEX IF NOT EXISTS observation_time ON observations(measured); PRAGMA user_version=1;');
    const row = this.db.prepare('SELECT data FROM state WHERE id=1').get() as {data: string} | undefined;
    this.consent = row ? consentSchema.parse(JSON.parse(row.data)) : emptyConsent();
    // Synthetic rows are separate even on disk. They can never become personal observations.
    this.db.exec('CREATE TABLE IF NOT EXISTS simulation (id TEXT PRIMARY KEY, measured INTEGER NOT NULL, data TEXT NOT NULL);');
    if (!this.beta || !this.consent.enabled) { this.consent.scenario = null; this.consent.reference = null; this.db.exec('DELETE FROM simulation'); }
    this.consent.lastSession = undefined; // A restart is a recording boundary.
    this.save(this.consent); this.index = this.makeIndex(); this.maintain(); this.reload();
    this.timer = setInterval(() => { try { this.maintain(); } catch { this.fail(); } }, 60_000); this.timer.unref();
  }
  private save(next: Consent) { this.db.prepare('INSERT INTO state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(next)); this.consent = next; }
  private table() { return this.consent.scenario ? 'simulation' : 'observations'; }
  private key(fix: LocationFix) { return `${fix.measured_at}:${fix.latitude}:${fix.longitude}`; }
  private makeIndex() {
    return new LocationHistoryIndex({now: this.now, source: this.consent.scenario ? 'synthetic_fixture' : 'phone_location', maximum: MAXIMUM,
      geography: fix => this.consent.scenario ? this.consent.scenario === 'no-map' ? undefined : geographicEvidence(fix, historyGeography) : this.geography.get(this.key(fix))});
  }
  private reload() {
    this.dirty = false; this.geography.clear();
    const rows = this.db.prepare(`SELECT data${this.table() === 'observations' ? ', geography' : ''} FROM ${this.table()} ORDER BY measured,id LIMIT ?`).all(MAXIMUM) as {data: string; geography?: string}[];
    const entries = rows.map(row => { const value = JSON.parse(row.data) as HistoryEntry;
      if (row.geography) this.geography.set(this.key(value), JSON.parse(row.geography)); return value; });
    this.index = this.makeIndex(); this.index.restore(entries, Math.max(this.consent.recordingEpoch, ...entries.map(x => x.recording_epoch)), !this.consent.scenario && this.consent.capacityOmitted);
    this.index.setReadable(this.consent.enabled && this.consent.scenario !== 'revoked');
  }
  private changed() { this.epoch = randomUUID(); this.reads.clear(); this.index.invalidate(); this.changes.emit(); }
  private fail() { this.healthy = false; this.reads.clear(); this.index?.setReadable(false); this.changes.emit(); }
  private authorized() { return !this.closed && this.healthy && this.consent.enabled && !!this.consent.owner && this.ownerAuthorized(this.consent.owner); }
  private checkOwner() {
    if (this.consent.owner && !this.ownerAuthorized(this.consent.owner)) {
      this.db.exec('DELETE FROM observations; DELETE FROM simulation'); this.save(emptyConsent()); this.reload(); this.changed();
    }
  }
  maintain() {
    if (this.closed) return;
    this.checkOwner();
    const cutoff = this.now() - HISTORY_RETENTION_MS;
    const a = this.db.prepare('DELETE FROM observations WHERE measured<=? OR measured>?').run(cutoff, this.now());
    const b = this.db.prepare('DELETE FROM simulation WHERE measured<=? OR measured>?').run(cutoff, this.now());
    if (a.changes || b.changes) { this.reload(); this.changed(); }
  }
  status(owner?: string) {
    try { this.maintain(); } catch { this.fail(); }
    const owns = !!owner && (!this.consent.owner || owner === this.consent.owner) && this.ownerAuthorized(owner);
    const count = owns && this.healthy ? Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.table()}`).get() as {n: number}).n) : 0;
    return { historyProtocol: this.healthy ? 1 : 0, historyEpoch: owns && this.healthy ? this.epoch : null,
      historyEnabled: owns && this.authorized(), historyCount: count, historySimulation: owns ? this.consent.scenario : null,
      historyReference: owns && this.consent.reference ? new Date(this.consent.reference).toISOString() : null,
      historyBeta: this.beta, historyRetentionHours: 168 };
  }
  control(raw: unknown, owner: string) {
    const input = controlSchema.parse(raw); this.maintain();
    if (!this.healthy || !this.ownerAuthorized(owner) || input.epoch !== this.epoch || (this.consent.owner && this.consent.owner !== owner)) throw failure();
    if (input.action === 'simulate' && (!this.beta || !this.consent.enabled || !input.scenario)) throw failure();
    const next = {...this.consent, owner};
    if (input.action === 'enable') { next.enabled = true; next.consentAt = this.now(); next.lastSession = undefined; }
    if (input.action === 'disable' || input.action === 'delete') { next.enabled = false; next.lastSession = undefined; next.scenario = null; next.reference = null; }
    if (input.action === 'finish_simulation') { next.scenario = null; next.reference = null; next.lastSession = undefined; }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.action === 'delete') { this.db.exec('DELETE FROM observations'); next.capacityOmitted = false; }
      if (['delete', 'disable', 'finish_simulation', 'simulate'].includes(input.action)) this.db.exec('DELETE FROM simulation');
      if (input.action === 'simulate') {
        next.scenario = input.scenario!; next.reference = this.now();
        const fixture = historyFixture(input.scenario!, next.reference);
        for (const entry of fixture.history.snapshot()) this.db.prepare('INSERT INTO simulation VALUES(?,?,?)').run(entry.id, Date.parse(entry.measured_at), JSON.stringify(entry));
      }
      this.save(next); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.fail(); throw error; }
    this.reload(); this.changed(); return this.status(owner);
  }
  ingest(fix: LocationFix, sharingId: string, raw: unknown, owner: string) {
    this.maintain(); const input = historyUploadSchema.parse(raw);
    if (!this.authorized() || this.consent.owner !== owner || input.epoch !== this.epoch || this.consent.scenario) return false;
    const measured = Date.parse(fix.measured_at);
    if (measured < this.consent.consentAt || measured > this.now() || measured <= this.now() - HISTORY_RETENTION_MS) return false;
    const id = createHash('sha256').update(`${owner}:${fix.measured_at}`).digest('hex');
    const next = {...this.consent};
    if (next.lastSession !== sharingId) { next.lastSession = sharingId; next.recordingEpoch++; }
    const observation = historyObservationSchema.parse({id, source: 'phone_location', ...fix,
      received_at: new Date(this.now()).toISOString(), ...(input.timezone ? {timezone: input.timezone} : {}),
      ...(input.utc_offset_minutes === undefined ? {} : {utc_offset_minutes: input.utc_offset_minutes})});
    const entry = {...observation, recording_epoch: next.recordingEpoch};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO observations(id,measured,data) VALUES(?,?,?)').run(id, measured, JSON.stringify(entry));
      if (!result.changes) { this.db.exec('ROLLBACK'); return false; }
      const evicted = this.db.prepare('DELETE FROM observations WHERE id IN (SELECT id FROM observations ORDER BY measured DESC,id DESC LIMIT -1 OFFSET ?)').run(MAXIMUM);
      if (evicted.changes) next.capacityOmitted = true;
      this.save(next); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.fail(); throw error; }
    // Defer the bounded index rebuild until a historical read, not every phone fix.
    this.dirty = true; this.index.invalidate(); this.changes.emit(); return true;
  }
  attachGeography(fix: LocationFix, evidence: GeographicEvidence, owner: string) {
    if (!this.authorized() || this.consent.owner !== owner || this.consent.scenario) return;
    const id = createHash('sha256').update(`${owner}:${fix.measured_at}`).digest('hex');
    const references = (items: GeographicEvidence['lines']) => items.slice(0, 2).map(item => ({id: item.id.slice(0, 100), kind: item.kind.slice(0, 50),
      ...(item.name ? {name: item.name.slice(0, 100)} : {}), relation: item.relation, distance_m: item.distance_m}));
    const bounded: GeographicEvidence = {source: evidence.source.slice(0, 120), release: evidence.release.slice(0, 80),
      attribution: evidence.attribution.slice(0, 250), license_url: evidence.license_url.slice(0, 250), areas: references(evidence.areas),
      lines: references(evidence.lines), landmarks: references(evidence.landmarks), limitations: evidence.limitations.slice(0, 2).map(x => x.slice(0, 150))};
    const text = JSON.stringify(bounded); if (Buffer.byteLength(text) > 4096) return;
    const updated = this.db.prepare('UPDATE observations SET geography=? WHERE id=?').run(text, id);
    if (updated.changes) { this.dirty = true; this.index.invalidate(); }
  }
  revokeOwner(owner: string) { if (this.consent.owner === owner) { this.db.exec('DELETE FROM observations; DELETE FROM simulation'); this.save(emptyConsent()); this.reload(); this.changed(); } }
  read(raw: unknown = {}) {
    this.maintain();
    if (!this.authorized()) return {status: 'unavailable', entries: [], next_cursor: null};
    if (this.dirty) this.reload();
    const result = this.index.read(raw);
    const id = randomUUID(); this.reads.set(id, {epoch: this.epoch, expires: this.now() + 5 * 60_000});
    while (this.reads.size > 50) this.reads.delete(this.reads.keys().next().value!);
    return {...result, history_context_id: id};
  }
  respond(raw: unknown) {
    const input = z.object({history_context_id: z.string().uuid(), utterance_id: z.string().uuid(), text: z.string().trim().min(1).max(2000)}).strict().parse(raw);
    const record = this.reads.get(input.history_context_id);
    const guard = () => { this.maintain(); if (!record || !this.authorized() || this.consent.scenario === 'revoked' || record.epoch !== this.epoch || record.expires <= this.now()) throw failure(); return true; };
    guard();
    return this.announce({message_id: input.history_context_id, utterance_id: input.utterance_id, text: input.text}, guard);
  }
  close() { if (this.closed) return; this.closed = true; clearInterval(this.timer); this.reads.clear(); this.index.clear(); this.geography.clear(); this.db.close(); }
}
