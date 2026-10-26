import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

const DAY = 86_400_000;
const KEY = /^[a-f0-9]{64}\.bin$/;
const MAGIC = 'dot-link-map-cache-v1';
export const MAP_CACHE_BYTES = 256 * 1024 * 1024;
export const MAP_ENTRY_BYTES = 32 * 1024 * 1024;

/** Reusable source bytes only. Callers must never use fixes or session IDs as keys/data. */
export class GeographicCache {
  private operations: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private readonly directory: string;
  private readonly options: { now?: () => number; maximumBytes?: number; maximumEntryBytes?: number };
  constructor(directory: string, options: {now?: () => number; maximumBytes?: number; maximumEntryBytes?: number} = {}) {
    this.directory = directory; this.options = options;
  }

  private day() { return Math.floor((this.options.now ?? Date.now)() / DAY); }
  private key(identity: string) { return createHash('sha256').update(identity).digest('hex') + '.bin'; }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operations.then(run, run);
    this.operations = next.catch(() => {});
    return next;
  }
  private async initialize() {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryInfo=await lstat(this.directory);
    if(!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink())throw new Error('Invalid map cache directory');
    await chmod(this.directory,0o700);
    await this.prune();
    this.initialized = true;
  }
  private async prune() {
    const files: {path: string; bytes: number; day: number}[] = [];
    for (const name of await readdir(this.directory)) {
      // Recover only our own abandoned atomic writes after an interrupted process.
      if (/^\.pending-[a-f0-9-]{36}$/.test(name)) {
        const path=join(this.directory,name);
        try {const info=await lstat(path);if(info.isFile()&&!info.isSymbolicLink()&&Date.now()-info.mtimeMs>3_600_000)await rm(path,{force:true});}catch{}
        continue;
      }
      // Only our opaque cache files are owned by this component.
      if (!KEY.test(name)) continue;
      const path = join(this.directory, name);
      try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat().finally(()=>handle.close());
        const day = Math.floor(info.mtimeMs / DAY);
        if (!info.isFile() || info.size > (this.options.maximumEntryBytes ?? MAP_ENTRY_BYTES) + 256 || this.day() - day >= 30 || day > this.day()) {
          await rm(path, { force: true }); continue;
        }
        files.push({path, bytes: info.size, day});
      } catch { /* Symlinks and files replaced externally are never read. */ }
    }
    let size = files.reduce((sum, file) => sum + file.bytes, 0);
    const maximum = this.options.maximumBytes ?? MAP_CACHE_BYTES;
    let remaining=files.length;
    for (const file of files.sort((a,b) => a.day - b.day || a.path.localeCompare(b.path))) {
      if (size <= maximum && remaining<=2048) break;
      await rm(file.path, {force: true}); size -= file.bytes; remaining--;
    }
  }

  get(identity: string): Promise<{bytes: Uint8Array; createdDay: number} | undefined> {
    return this.serial(async () => {
      await this.initialize();
      const path = join(this.directory, this.key(identity));
      let handle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        const usedDay = Math.floor(info.mtimeMs / DAY);
        if (!info.isFile() || info.size > (this.options.maximumEntryBytes ?? MAP_ENTRY_BYTES) + 256 || this.day() - usedDay >= 30 || usedDay > this.day()) return undefined;
        const data = await handle.readFile();
        const end = data.indexOf(10);
        if (end < 0 || end > 200) return undefined;
        const header = JSON.parse(data.subarray(0,end).toString('utf8'));
        if (header.magic !== MAGIC || !Number.isInteger(header.createdDay) || header.createdDay > this.day() || header.createdDay < 0) return undefined;
        const payload=data.subarray(end+1);
        if(header.sha256!==createHash('sha256').update(payload).digest('hex'))return undefined;
        // Round both filesystem use timestamps to a day. Never record fix time.
        if (usedDay !== this.day()) await handle.utimes(this.day() * DAY / 1000, this.day() * DAY / 1000);
        return {bytes: payload, createdDay: header.createdDay};
      } catch { return undefined; }
      finally { await handle?.close(); }
    });
  }

  put(identity: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (bytes.byteLength > (this.options.maximumEntryBytes ?? MAP_ENTRY_BYTES)) throw new Error('Map cache entry limit');
      await this.initialize();
      const path = join(this.directory, this.key(identity));
      const temporary = join(this.directory, `.pending-${randomUUID()}`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(Buffer.concat([Buffer.from(JSON.stringify({magic: MAGIC, createdDay: this.day(), sha256:createHash('sha256').update(bytes).digest('hex')}) + '\n'), bytes]));
          await handle.utimes(this.day() * DAY / 1000, this.day() * DAY / 1000);
        } finally { await handle.close(); }
        signal?.throwIfAborted();
        await rename(temporary, path);
        await this.prune();
      } finally { await rm(temporary, {force: true}); }
    });
  }

  maintain(): Promise<void> { return this.serial(async () => { await this.initialize(); await this.prune(); }); }
}
