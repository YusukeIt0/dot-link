import { GeographicCache } from './cache.ts';

const CHUNK = 256 * 1024;
const REQUEST_CHUNKS = 8;
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
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > byteLength || end < start || end - start > 64 * 1024 * 1024) throw new Error('Invalid map range');
      if(start===end)return new ArrayBuffer(0);
      const alignedStart=Math.floor(start/CHUNK)*CHUNK,alignedEnd=Math.min(byteLength,Math.ceil(end/CHUNK)*CHUNK);
      const data = new Uint8Array(end-start);
      // Keep the existing 256 KiB cache identities, but transfer adjacent misses
      // together. Three windows cap temporary response data at 6 MiB per read.
      for (let offset = alignedStart; offset < alignedEnd; offset += CHUNK * REQUEST_CHUNKS * 3) {
        this.signal.throwIfAborted();
        const batch: Promise<void>[] = [];
        for (let i = offset; i < Math.min(alignedEnd,offset+CHUNK*REQUEST_CHUNKS*3); i += CHUNK*REQUEST_CHUNKS) {
          const windowStart = i, windowEnd = Math.min(alignedEnd,i+CHUNK*REQUEST_CHUNKS);
          batch.push((async () => {
            const chunks: {start:number;end:number;identity:string;bytes?:Uint8Array}[] = [];
            const copy = (position:number,bytes:Uint8Array) => {
              const from=Math.max(start,position),to=Math.min(end,position+bytes.byteLength);
              if(to>from)data.set(bytes.subarray(from-position,to-position),from-start);
            };
            for(let a=windowStart;a<windowEnd;a+=CHUNK) {
              const b=Math.min(windowEnd,a+CHUNK), identity=`${url}#${byteLength}:${a}:${b}`;
              const cached=await this.cache.get(identity);
              this.signal.throwIfAborted();
              const bytes=cached?.bytes.byteLength===b-a?cached.bytes:undefined;
              if(bytes){this.stats.cacheBytes+=bytes.byteLength;copy(a,bytes);}
              chunks.push({start:a,end:b,identity,bytes});
            }
            for(let first=0;first<chunks.length;) {
              if(chunks[first].bytes){first++;continue;}
              let last=first;
              while(last+1<chunks.length&&!chunks[last+1].bytes)last++;
              const a=chunks[first].start,b=chunks[last].end;
              const bytes=await this.fetchBounded(url,{Range:`bytes=${a}-${b-1}`},{start:a,end:b,length:byteLength});
              for(let index=first;index<=last;index++) {
                const chunk=chunks[index],part=bytes.subarray(chunk.start-a,chunk.end-a);
                await this.cache.put(chunk.identity,part,this.signal);copy(chunk.start,part);
              }
              first=last+1;
            }
          })());
        }
        await Promise.all(batch);
      }
      return data.buffer;
    }};
  }
}
