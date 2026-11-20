import {lstatSync} from 'node:fs';
import {RainRateCache, FETCH_TIMEOUT, type StoredFrame} from './cache.ts';
import {acquireFrame, chooseEdition, discoverFrames, freshFrame} from './discovery.ts';
import {decodeRainRate, type RainRateSample} from './decoder.ts';

type Point = {latitude: number; longitude: number};
export interface NearbyRainRead {sample: RainRateSample; frame: StoredFrame}

/** Demand-driven public-frame acquisition. Callers supply their live consent signal.
 * Reading an area only opens verified local data and never issues a network request. */
export class RainRateService {
  private readonly directory: string;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly decode: typeof decodeRainRate;
  private stopped = new AbortController();
  private closed = false;
  private acquiring = false;
  private reading = false;
  constructor(directory: string, options: {request?: typeof fetch; now?: () => number; decode?: typeof decodeRainRate} = {}) {
    this.directory = directory; this.request = options.request ?? fetch; this.now = options.now ?? Date.now; this.decode = options.decode ?? decodeRainRate;
  }
  cancel() {this.stopped.abort(); this.stopped = new AbortController();}
  close() {this.closed = true; this.cancel();}
  async refresh(authority: AbortSignal): Promise<'updated' | 'cached' | 'unavailable'> {
    if (this.acquiring || this.closed || authority.aborted) return 'unavailable';
    this.acquiring = true;
    const signal = AbortSignal.any([authority, this.stopped.signal, AbortSignal.timeout(FETCH_TIMEOUT)]);
    let cache: RainRateCache | undefined;
    const result: {status: 'updated' | 'cached' | 'unavailable'} = {status: 'unavailable'};
    try {
      cache = new RainRateCache(this.directory);
      const store = cache;
      await store.acquire(this.now(), async reserve => {
        const candidates = await discoverFrames(this.now(), this.request, reserve, signal);
        signal.throwIfAborted();
        const frame = chooseEdition(candidates.filter(f => freshFrame(f, this.now())));
        if (!frame) return;
        const newest = store.frames().find(f => freshFrame(f, this.now()));
        if (newest && (newest.start > frame.start || (newest.start === frame.start &&
          (newest.inputs > frame.inputs || (newest.inputs === frame.inputs && newest.created > frame.created))))) return;
        if (newest?.key === frame.key && newest.etag === frame.etag) {
          if (store.complete(newest)) {result.status = 'cached'; return;}
        }
        const {bytes, checksum} = await acquireFrame(frame, this.request, reserve, signal);
        signal.throwIfAborted();
        if (!freshFrame(frame, this.now())) return;
        const sameEdition = newest?.key === frame.key && newest.etag === frame.etag && newest.checksum === checksum;
        store.store(frame, checksum, bytes, sameEdition ? newest.retrieved : this.now());
        result.status = 'updated';
      });
      return result.status;
    } catch {return 'unavailable';}
    finally {cache?.close(); this.acquiring = false;}
  }
  async read(point: Point, authority: AbortSignal, options: {previous?: boolean} = {}): Promise<NearbyRainRead[]> {
    if (this.reading || this.closed || authority.aborted || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
      !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) return [];
    this.reading = true;
    const position = {latitude: point.latitude, longitude: point.longitude};
    const signal = AbortSignal.any([authority, this.stopped.signal, AbortSignal.timeout(FETCH_TIMEOUT)]);
    let cache: RainRateCache | undefined;
    try {
      cache = new RainRateCache(this.directory);
      const result: NearbyRainRead[] = [];
      for (const frame of cache.frames()) {
        if (!freshFrame(frame, this.now()) || frame.retrieved > this.now()) continue;
        signal.throwIfAborted();
        try {
          if (!lstatSync(cache.path(frame), {throwIfNoEntry: false})?.isFile()) continue;
          const sample = await this.decode(cache.path(frame), frame, position, signal);
          signal.throwIfAborted();
          if (freshFrame(frame, this.now())) result.push({frame, sample});
        } catch {signal.throwIfAborted(); cache.dropDamaged(frame);}
        if (result.length >= (options.previous ? 2 : 1)) break;
      }
      signal.throwIfAborted();
      const current = cache.frames();
      return result.filter(r => freshFrame(r.frame, this.now()) &&
        current.some(f => f.key === r.frame.key && f.etag === r.frame.etag && f.retrieved === r.frame.retrieved));
    } catch {return [];}
    finally {cache?.close(); this.reading = false;}
  }
}
