import {readFileSync} from 'node:fs';
const {version} = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {version: string};
/** Fixed provider origins only. No redirects, retries, credentials or URL logging. */
export class MobilityNetwork {
  private active = 0;
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = fetch) { this.request = request; }
  async bytes(url: URL, signal: AbortSignal, maximum: number): Promise<Buffer> {
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['api.transitous.org', 's3.amazonaws.com'].includes(url.hostname)) throw new Error('Unsupported mobility source');
    signal.throwIfAborted();
    // Fail closed instead of accumulating a queue behind ordinary conversation.
    if (this.active >= 3) throw new Error('Mobility source busy');
    this.active++;
    const deadline = AbortSignal.timeout(15_000);
    const combined = AbortSignal.any([signal, deadline]);
    let response: Response | undefined;
    try {
      response = await this.request(url, {signal: combined, redirect: 'error', credentials: 'omit',
        headers: {'User-Agent': `Dot-Link/${version} (+https://github.com/YusukeIt0/dot-link)`}});
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
          length += value.byteLength;
          if (length > maximum) throw new Error('Oversized mobility response');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return Buffer.concat(chunks, length);
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      this.active--;
    }
  }
}
