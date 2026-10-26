import { GeographicCache } from './cache.ts';

const CHUNK = 256 * 1024;
const AGENT = 'DotLink/GeographicContext (+https://github.com/YusukeIt0/dot-link)';
const HOSTS = new Set(['stac.overturemaps.org', 'overturemapswestus2.blob.core.windows.net']);
export function validMapURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash) throw new Error('Unsupported map source');
  if (url.pathname.includes('..') || !/^\/[a-zA-Z0-9_./=+-]+$/.test(url.pathname)) throw new Error('Unsupported map path');
  return url;
}

/** One bounded acquisition. Persistent cache contains public map bytes only. */
export class MapDownload {
  private readonly cache: GeographicCache;
  private readonly signal: AbortSignal;
  private readonly request: typeof fetch;
  private active = 0;
  private waiting: (() => void)[] = [];
  private reserved = 0;
  private requests = 0;
  readonly stats = { downloadedBytes: 0, cacheBytes: 0 };
  constructor(cache: GeographicCache, signal: AbortSignal, request: typeof fetch = fetch) {
    this.cache = cache; this.signal = signal; this.request = request;
  }
  private async fetchBounded(url: string, headers: Record<string,string>, expected?: {start: number; end: number; length: number}): Promise<Uint8Array> {
    validMapURL(url); this.signal.throwIfAborted();
    const maximum = expected ? expected.end - expected.start : 2 * 1024 * 1024;
    if (maximum < 1 || maximum > 2 * 1024 * 1024 || this.reserved + maximum > 80 * 1024 * 1024 || ++this.requests > 500) throw new Error('Map download budget');
    this.reserved += maximum;
    if (this.active >= 3) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try {
      this.signal.throwIfAborted();
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]);
      const response = await this.request(url,{headers:{'User-Agent':AGENT,...headers},redirect:'error',signal});
      if (response.status !== (expected ? 206 : 200)) { await response.body?.cancel(); throw new Error('Map response status'); }
      if (expected && response.headers.get('content-range') !== `bytes ${expected.start}-${expected.end-1}/${expected.length}`) {
        await response.body?.cancel(); throw new Error('Map response range');
      }
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {await response.body?.cancel(); throw new Error('Map response length');}
      if (!response.body) throw new Error('Empty map response');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const {done,value} = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > maximum) throw new Error('Map response exceeds limit');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (expected && length !== maximum) throw new Error('Truncated map range');
      this.stats.downloadedBytes += length;
      return Buffer.concat(chunks);
    } finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  async document(url: string): Promise<Uint8Array> { return this.fetchBounded(url,{}); }
  async json(url: string): Promise<unknown> {
    const data = await this.fetchBounded(url,{});
    return JSON.parse(Buffer.from(data).toString('utf8'));
  }
  async file(url: string, byteLength: number) {
    validMapURL(url);
    if (!Number.isSafeInteger(byteLength) || byteLength < 8 || byteLength > 10_000_000_000) throw new Error('Invalid map file size');
    return {byteLength, slice: async (start: number, end = byteLength): Promise<ArrayBuffer> => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > byteLength || end < start || end - start > 32 * 1024 * 1024) throw new Error('Invalid map range');
      if(start===end)return new ArrayBuffer(0);
      const alignedStart=Math.floor(start/CHUNK)*CHUNK,alignedEnd=Math.min(byteLength,Math.ceil(end/CHUNK)*CHUNK);
      const parts: Uint8Array[] = [];
      // Bounded batches: never queue a whole planet file or unbounded requests.
      for (let offset = alignedStart; offset < alignedEnd; offset += CHUNK * 3) {
        this.signal.throwIfAborted();
        const batch = [];
        for (let i = offset; i < Math.min(alignedEnd,offset+CHUNK*3); i += CHUNK) {
          const a = i, b = Math.min(alignedEnd,i+CHUNK);
          batch.push((async () => {
            const identity = `${url}#${byteLength}:${a}:${b}`;
            const cached = await this.cache.get(identity);
            this.signal.throwIfAborted();
            if (cached && cached.bytes.byteLength === b-a) {this.stats.cacheBytes += cached.bytes.byteLength; return cached.bytes;}
            const bytes = await this.fetchBounded(url,{Range:`bytes=${a}-${b-1}`},{start:a,end:b,length:byteLength});
            await this.cache.put(identity,bytes,this.signal); return bytes;
          })());
        }
        parts.push(...await Promise.all(batch));
      }
      const data = Buffer.concat(parts).subarray(start-alignedStart,end-alignedStart);
      return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength) as ArrayBuffer;
    }};
  }
}
