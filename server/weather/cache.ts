import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { weatherForecastSchema } from './types.ts';

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
export const weatherCacheSchema = z.object({
  version: z.literal(1), nextRequestAt: timestamp,
  entries: z.array(z.object({
    key: z.string().regex(/^[a-f0-9]{64}$/), nextRequestAt: timestamp,
    retrievedAt: timestamp, checkedAt: timestamp, deprecated: z.boolean(), refreshFailed: z.boolean(),
    lastModified: z.string().max(100).optional(), forecast: weatherForecastSchema.optional(),
  }).strict()).max(64),
}).strict();
export type WeatherCacheState = z.infer<typeof weatherCacheSchema>;
export type WeatherCacheEntry = WeatherCacheState['entries'][number];
const MAX_BYTES = 2 * 1024 * 1024;
const DAY = 86_400_000;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const editionRowsSchema = z.array(z.tuple([digestSchema, digestSchema, z.boolean()])).max(128);
type EditionRow = z.infer<typeof editionRowsSchema>[number];
function forecastBinding(entry: WeatherCacheEntry) {
  return createHash('sha256').update(JSON.stringify([entry.key, entry.retrievedAt, entry.forecast])).digest('hex');
}

async function replacePrivateFile(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content); await handle.sync();
    await rename(temporary, path);
  } finally {await handle?.close(); await rm(temporary, {force: true});}
}

/** One relay owns this file. Coarse forecasts expire; cooldown hashes prevent refetch storms. */
export class WeatherCache {
  private readonly path: string;
  private readonly now: () => number;
  constructor(path: string, now: () => number = Date.now) {this.path = path; this.now = now;}
  private previousEditions: EditionRow[] = [];
  private get editionsPath() {return this.path + '.editions';}
  private async readEditions(): Promise<EditionRow[]> {
    let handle;
    try {
      handle = await open(this.editionsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 20_000 || (info.mode & 0o077)) return [];
      const buffer = Buffer.alloc(info.size + 1);
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== info.size) return [];
      return editionRowsSchema.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
    } catch {return [];}
    finally {await handle?.close().catch(() => {});}
  }
  private async restoreEditions(state: WeatherCacheState) {
    const saved = new Map((await this.readEditions()).map(row => [row[0], row]));
    this.previousEditions = [];
    for (const entry of state.entries) {
      if (!entry.forecast || entry.forecast.edition) continue;
      const metadata = saved.get(forecastBinding(entry));
      if (metadata) {
        entry.forecast.edition = metadata[1];
        this.previousEditions.push(metadata);
      }
      if (!metadata?.[2]) entry.forecast.first_retrieval_unverified = true;
    }
    return state;
  }
  async read(): Promise<WeatherCacheState> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Invalid weather cache');
      await handle.chmod(0o600);
      try {
        if (info.size > MAX_BYTES) throw new Error('Oversized weather cache');
        const content = await handle.readFile('utf8');
        return this.restoreEditions(weatherCacheSchema.parse(JSON.parse(content)));
      } catch (error) {
        // Recover invalid data only, never permission/read errors or nonregular paths.
        if ((error as NodeJS.ErrnoException).code) throw error;
        const current = await lstat(this.path);
        if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) throw new Error('Weather cache changed');
        // Atomically replace unusable data with a conservative blackout. Do not
        // retain corrupt coordinate payloads indefinitely in a diagnostic copy.
        const recovered: WeatherCacheState = {version: 1, nextRequestAt: this.now() + DAY, entries: []};
        await this.write(recovered);
        return recovered;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {version: 1, nextRequestAt: 0, entries: []};
      // Do not erase request-suppression evidence and then issue another request.
      throw new Error('Weather cache unavailable');
    } finally {await handle?.close();}
  }
  async write(state: WeatherCacheState): Promise<void> {
    // A downgraded app must keep its current forecast and rate-limit state.
    // The strict v1 format never contained edition or acquisition provenance.
    const compatible = weatherCacheSchema.parse(state);
    const next: EditionRow[] = [];
    for (const entry of compatible.entries) {
      if (!entry.forecast) continue;
      const {edition, first_retrieval_unverified} = entry.forecast;
      delete entry.forecast.edition;
      delete entry.forecast.first_retrieval_unverified;
      if (edition) next.push([forecastBinding(entry), edition, !first_retrieval_unverified]);
    }
    const content = JSON.stringify(compatible);
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Weather cache too large');
    const directory = dirname(this.path);
    await mkdir(directory, {recursive: true, mode: 0o700});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid weather directory');
    await chmod(directory, 0o700);
    // Bind both generations before the atomic v1 replacement. A crash between
    // renames leaves matching metadata for the file that actually survived.
    // Optional metadata failure cannot discard a forecast or relax a cooldown.
    const retained = new Map(this.previousEditions.map(row => [row[0], row]));
    for (const row of next) retained.set(row[0], row);
    if (next.length) await replacePrivateFile(this.editionsPath, JSON.stringify([...retained.values()])).catch(() => {});
    await replacePrivateFile(this.path, content);
    this.previousEditions = next;
    if (!next.length) await rm(this.editionsPath, {force: true}).catch(() => {});
    else if (retained.size > next.length) await replacePrivateFile(this.editionsPath, JSON.stringify(next)).catch(() => {});
  }
}

export function pruneWeatherCache(state: WeatherCacheState, now: number): void {
  for (const entry of state.entries) {
    if (entry.checkedAt > now + 300_000 || now - entry.checkedAt >= DAY) {
      delete entry.forecast; delete entry.lastModified;
    }
  }
  // Never evict a still-effective cooldown just to permit another identical query.
  state.entries = state.entries.filter(e => e.forecast || e.nextRequestAt > now);
  const forecasts = state.entries.filter(e => e.forecast).sort((a, b) => b.checkedAt - a.checkedAt);
  for (const entry of forecasts.slice(16)) {delete entry.forecast; delete entry.lastModified;}
  state.entries = state.entries.filter(e => e.forecast || e.nextRequestAt > now);
}
