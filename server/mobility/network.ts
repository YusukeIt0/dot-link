import {readFileSync} from 'node:fs';
const {version} = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {version: string};
let activeRequests = 0;
const cooldowns = new Map<string, number>();
let walkingActive = false;
let nextWalkingRequest = 0;

/** Fixed provider origins only. No redirects, retries, credentials or URL logging. */
export class MobilityNetwork {
  private requests = 0;
  private receivedBytes = 0;
  private readonly request: typeof fetch;
  private readonly beforeRequest: () => void;
  constructor(request: typeof fetch = fetch, beforeRequest: () => void = () => {}) { this.request = request; this.beforeRequest = beforeRequest; }
  stats() { return {requests: this.requests, received_bytes: this.receivedBytes}; }
  async bytes(url: URL, signal: AbortSignal, maximum: number): Promise<Buffer> {
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['s3.amazonaws.com', 'routing.openstreetmap.de'].includes(url.hostname)) throw new Error('Unsupported mobility source');
    signal.throwIfAborted();
    this.beforeRequest();
    if (url.hash) throw new Error('Unsupported mobility fragment');
    if (url.hostname === 's3.amazonaws.com' && (url.search || !/^\/elevation-tiles-prod\/terrarium\/12\/\d{1,4}\/\d{1,4}\.png$/.test(url.pathname))) throw new Error('Unsupported terrain endpoint');
    if ((cooldowns.get(url.hostname) ?? 0) > performance.now()) throw new Error('Mobility source cooling down');
    const walking = url.hostname === 'routing.openstreetmap.de';
    if (walking && !url.pathname.startsWith('/routed-foot/route/v1/foot/')) throw new Error('Unsupported walking endpoint');
    if (walking && (walkingActive || performance.now() < nextWalkingRequest)) throw new Error('Walking source busy');
    // Fail closed instead of accumulating a queue behind ordinary conversation.
    if (activeRequests >= 3) throw new Error('Mobility source busy');
    activeRequests++;
    if (walking) { walkingActive = true; nextWalkingRequest = performance.now() + 1100; }
    const deadline = AbortSignal.timeout(15_000);
    const combined = AbortSignal.any([signal, deadline]);
    let response: Response | undefined;
    try {
      this.requests++;
      response = await this.request(url, {signal: combined, redirect: 'error', credentials: 'omit',
        method: 'GET',
        headers: {'User-Agent': `Dot-Link/${version} (+https://github.com/YusukeIt0/dot-link)`}});
      if (response.status === 429 || response.status === 503) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - Date.now()) / 1000 : 60;
        cooldowns.set(url.hostname, performance.now() + Math.max(60, Number.isFinite(seconds) ? seconds : 60) * 1000);
      }
      if (!response.ok || !response.body) throw new Error('Mobility source unavailable');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error('Oversized mobility response');
      const reader = response.body.getReader();
      const chunks: Buffer[] = []; let length = 0;
      try {
        for (;;) {
          combined.throwIfAborted();
          const {done, value} = await reader.read();
          combined.throwIfAborted();
          if (done) break;
          this.receivedBytes += value.byteLength;
          length += value.byteLength;
          if (length > maximum) throw new Error('Oversized mobility response');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return Buffer.concat(chunks, length);
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      activeRequests--;
      if (walking) walkingActive = false;
    }
  }
}
