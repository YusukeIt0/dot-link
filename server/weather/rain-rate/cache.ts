import {createHash} from 'node:crypto';
import {closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {crc32} from 'node:zlib';
import {frameFromKey, freshFrame, FRAME_AGE, LIST_LIMIT, OBJECT_LIMIT, type RainRateFrame} from './discovery.ts';
import type {probeRainRateFrame} from './decoder.ts';

const DAY = 86_400_000;
export const FETCH_TIMEOUT = 90_000;
export const COOLDOWN = 10 * 60_000;
export const DAILY_BYTES = 64 * 1024 * 1024;
export type StoredFrame = RainRateFrame & {checksum: string; retrieved: number};
function basename(f: RainRateFrame & {checksum: string}) {
  return createHash('sha256').update(JSON.stringify([f.key, f.etag, f.checksum])).digest('hex') + '.nc';
}
function decodeRow(r: Record<string, unknown>): StoredFrame {
  const f = frameFromKey(String(r.key), String(r.etag), Number(r.size), Number(r.published));
  if (!f || typeof r.checksum !== 'string' || !/^[A-Za-z0-9+/]{6}==$/.test(r.checksum) ||
    !Number.isSafeInteger(r.retrieved) || Number(r.retrieved) < f.published) throw Error('Invalid NOAA cache record');
  return {...f, checksum: r.checksum, retrieved: Number(r.retrieved)};
}
function regularIfPresent(path: string, maxSize: number) {
  const info = lstatSync(path, {throwIfNoEntry: false});
  if (info && (!info.isFile() || info.size > maxSize)) throw Error('Invalid NOAA cache file');
}
export class RainRateCache {
  readonly directory: string;
  private readonly db: DatabaseSync;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, {mode: 0o700, recursive: true});
    if (!lstatSync(directory).isDirectory()) throw Error('Invalid NOAA cache directory');
    const path = join(directory, 'frames.sqlite');
    regularIfPresent(path, 1024 * 1024);
    regularIfPresent(path + '-journal', 1024 * 1024);
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA trusted_schema=OFF; PRAGMA max_page_count=200;
        CREATE TABLE IF NOT EXISTS transfers (id INTEGER PRIMARY KEY, at INTEGER NOT NULL CHECK(at>=0),
          bytes INTEGER NOT NULL CHECK(bytes>=0 AND bytes<=${OBJECT_LIMIT + 2 * LIST_LIMIT}));
        CREATE TABLE IF NOT EXISTS frames (key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL,
          published INTEGER NOT NULL, checksum TEXT NOT NULL, retrieved INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS inspections (key TEXT PRIMARY KEY, etag TEXT NOT NULL, end INTEGER NOT NULL,
          supported INTEGER NOT NULL CHECK(supported IN(0,1)));`);
    } catch (e) {db.close(); throw e;}
    this.db = db;
    this.reconcile();
  }
  close() {this.db.close();}
  path(f: RainRateFrame & {checksum: string}) {return join(this.directory, basename(f));}
  complete(f: StoredFrame) {
    let fd;
    try {
      fd = openSync(this.path(f), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size !== f.size) return false;
      const bytes = Buffer.alloc(f.size + 1);
      return readSync(fd, bytes, 0, bytes.length, 0) === f.size &&
        crc32(bytes.subarray(0, f.size)) === Buffer.from(f.checksum, 'base64').readUInt32BE();
    } catch {return undefined;}
    finally {if (fd !== undefined) closeSync(fd);}
  }
  dropDamaged(f: StoredFrame) {
    // Keep the edition's first-retrieved clock. Removing only failed cached
    // bytes avoids retrying the decoder offline; the next authorized fetch can repair it.
    this.tryMaintenance(() => {
      if (lstatSync(this.path(f), {throwIfNoEntry: false})?.isFile() && this.complete(f) === false) unlinkSync(this.path(f));
    });
  }
  frames() {
    const rows = this.db.prepare('SELECT * FROM frames LIMIT 4').all();
    if (rows.length > 3) throw Error('Invalid NOAA cache inventory');
    return rows.map(decodeRow).sort((a, b) => b.start - a.start || b.inputs - a.inputs || b.created - a.created);
  }
  supported(frame: RainRateFrame): boolean | undefined {
    const row = this.db.prepare('SELECT supported FROM inspections WHERE key=? AND etag=?').get(frame.key, frame.etag);
    return row && row.supported === 1;
  }
  async inspect(path: string, frame: StoredFrame, probe: typeof probeRainRateFrame, signal: AbortSignal, now: () => number) {
    const verdict = await probe(path, frame, signal);
    signal.throwIfAborted();
    if (!freshFrame(frame, now())) return false;
    // Only definitive decoder verdicts reach this point. Transient worker,
    // filesystem and authorization failures leave the edition eligible to retry.
    const supported = verdict === 'supported';
    this.db.prepare('INSERT OR REPLACE INTO inspections(key,etag,end,supported) VALUES(?,?,?,?)')
      .run(frame.key, frame.etag, frame.end, supported ? 1 : 0);
    return supported;
  }
  private discardOrphans(kept: StoredFrame[]) {
    const names = new Set(kept.map(basename));
    for (const name of readdirSync(this.directory)) {
      if (name === '.incoming' || (/^[a-f0-9]{64}\.nc$/.test(name) && !names.has(name))) unlinkSync(join(this.directory, name));
    }
  }
  private tryMaintenance(action: () => void) {
    try {this.db.exec('BEGIN IMMEDIATE');} catch {return;}
    try {action(); this.db.exec('COMMIT');}
    catch {this.db.exec('ROLLBACK');}
  }
  private reconcile() {
    this.tryMaintenance(() => this.discardOrphans(this.frames()));
  }
  /** A committed worst-case reservation survives process death. A second,
   * immediate writer transaction serializes network work even across relays.
   * On clean completion refund only unissued requests; a started stream is charged in full. */
  async acquire(now: number, signal: AbortSignal, action: (reserve: (bytes: number) => void) => Promise<void>) {
    signal.throwIfAborted();
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    let reservation = 0; let row: number | bigint = 0;
    try {
      db.prepare('DELETE FROM transfers WHERE at < ?').run(now - DAY - FETCH_TIMEOUT);
      db.prepare('DELETE FROM inspections WHERE end < ?').run(now - FRAME_AGE);
      const totals = db.prepare('SELECT max(at) AS last, coalesce(sum(bytes),0) AS bytes FROM transfers').get()!;
      const remaining = DAILY_BYTES - Number(totals.bytes);
      if ((totals.last !== null && now - Number(totals.last) < COOLDOWN) || remaining < LIST_LIMIT) {
        db.exec('COMMIT'); return;
      }
      reservation = Math.min(remaining, OBJECT_LIMIT + 2 * LIST_LIMIT);
      row = db.prepare('INSERT INTO transfers(at,bytes) VALUES(?,?)').run(now, reservation).lastInsertRowid;
      db.exec('COMMIT');
    } catch (error) {db.exec('ROLLBACK'); throw error;}
    db.exec('BEGIN IMMEDIATE');
    let charged = 0;
    try {
      const cached = this.frames();
      this.discardOrphans(cached);
      await action(bytes => {
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || charged + bytes > reservation) throw Error('NOAA download budget');
        charged += bytes;
      });
      signal.throwIfAborted();
      db.prepare('UPDATE transfers SET bytes=? WHERE id=?').run(charged, row);
      db.exec('COMMIT');
    } catch (error) {
      // Retain each started request's full charge even if the stream failed.
      // A crash or write failure leaves the larger committed reservation.
      db.exec('ROLLBACK');
      db.prepare('UPDATE transfers SET bytes=? WHERE id=?').run(charged, row);
      throw error;
    } finally {this.reconcile();}
  }
  async store(frame: StoredFrame, bytes: Buffer, probe: typeof probeRainRateFrame, signal: AbortSignal, now: () => number) {
    signal.throwIfAborted();
    if (!freshFrame(frame, now())) return false;
    const {checksum, retrieved} = frame;
    const old = this.frames();
    const keep = old.filter(f => f.start !== frame.start)
      .sort((a, b) => b.start - a.start).slice(0, 2);
    const temporary = join(this.directory, '.incoming');
    writeFileSync(temporary, bytes, {flag: 'wx', mode: 0o600, flush: true});
    try {
      if (!await this.inspect(temporary, frame, probe, signal, now)) return false;
      signal.throwIfAborted();
      if (!freshFrame(frame, now())) return false;
      for (const f of old) if (!keep.includes(f)) {
        this.db.prepare('DELETE FROM frames WHERE key=?').run(f.key);
      }
      // This new object is the single staged file until the index commits.
      // Readers keep every old object throughout possible rollback or process death.
      renameSync(temporary, this.path({...frame, checksum}));
      const directory = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {fsyncSync(directory);} finally {closeSync(directory);}
      this.db.prepare('INSERT INTO frames(key,etag,size,published,checksum,retrieved) VALUES(?,?,?,?,?,?)')
        .run(frame.key, frame.etag, frame.size, frame.published, checksum, retrieved);
      return true;
    } finally {if (existsSync(temporary)) unlinkSync(temporary);}
  }
}
