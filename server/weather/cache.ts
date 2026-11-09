import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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

/** One relay owns this file. Coarse forecasts expire; cooldown hashes prevent refetch storms. */
export class WeatherCache {
  private readonly path: string;
  constructor(path: string) {this.path = path;}
  async read(): Promise<WeatherCacheState> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid weather cache');
      await handle.chmod(0o600);
      return weatherCacheSchema.parse(JSON.parse(await handle.readFile('utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {version: 1, nextRequestAt: 0, entries: []};
      // Do not erase request-suppression evidence and then issue another request.
      throw new Error('Weather cache unavailable');
    } finally {await handle?.close();}
  }
  async write(state: WeatherCacheState): Promise<void> {
    const content = JSON.stringify(weatherCacheSchema.parse(state));
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Weather cache too large');
    const directory = dirname(this.path);
    await mkdir(directory, {recursive: true, mode: 0o700});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid weather directory');
    await chmod(directory, 0o700);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(content); await handle.sync();
      await rename(temporary, this.path);
    } finally {await handle?.close(); await rm(temporary, {force: true});}
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
