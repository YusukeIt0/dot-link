import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';

export type Destination = { id: string; url: string; secret: string };
export type Delivery = { status: number; body: string };
export type Post = (url: string, body: string, headers: Record<string, string>) => Promise<Delivery>;
export class CallbackVerificationError extends Error {
  constructor() { super('Callback verification failed'); }
}
export class CallbackDestinationError extends Error {
  readonly hostname: string;
  constructor(hostname: string) {
    super('Callback destination is not allowed');
    this.hostname = /^[a-z0-9.-]{1,253}$/i.test(hostname) ? hostname : '[invalid hostname]';
  }
}

export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

export function callbackUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || !allowedHosts.includes(url.hostname)) {
    throw new CallbackDestinationError(url.hostname);
  }
  return url;
}

// Connect to a freshly validated DNS result; retain the original hostname for TLS and Host.
export function safePost(allowedHosts: readonly string[]): Post {
  return async (value, body, headers) => {
    const url = callbackUrl(value, allowedHosts);
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) {
      throw new Error('Callback DNS returned a non-public address');
    }
    const address = addresses[0];
    return new Promise<Delivery>((resolve, reject) => {
      const req = request(url, {
        method: 'POST', agent: false, signal: AbortSignal.timeout(10_000),
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        lookup: (_host, options, done) => {
          if (options.all) done(null, [address]);
          else done(null, address.address, address.family);
        },
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) { response.destroy(); reject(new Error('Callback response too large')); }
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(body); // No redirect following; 3xx is handled as a failed delivery.
    });
  };
}

export function signingSecret(value: string): string {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid signing secret');
  const bytes = Buffer.from(value.slice(6), 'base64');
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64') !== value.slice(6)) {
    throw new Error('Invalid signing secret');
  }
  return value;
}

export class WebhookSender {
  private post: Post;
  constructor(post: Post) { this.post = post; }
  async send(destination: Destination, id: string, payload: unknown): Promise<Delivery> {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 262_144) throw new Error('Event payload too large');
    const now = new Date();
    const signature = new Webhook(signingSecret(destination.secret)).sign(id, now, body);
    return this.post(destination.url, body, {
      'Content-Type': 'application/json',
      'webhook-id': id, 'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
      'webhook-signature': signature, 'X-MCP-Subscription-Id': destination.id,
    });
  }
  async verify(destination: Destination): Promise<void> {
    const challenge = randomUUID();
    let response: Delivery;
    try { response = await this.send(destination, `verify_${randomUUID()}`, { type: 'verification', challenge }); }
    catch { throw new CallbackVerificationError(); }
    let echoed: unknown;
    try { echoed = JSON.parse(response.body).challenge; } catch { /* rejected below */ }
    if (response.status < 200 || response.status >= 300 || typeof echoed !== 'string' ||
      Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
      !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) throw new CallbackVerificationError();
  }
}
