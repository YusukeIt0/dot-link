import { createServer, type IncomingMessage } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { authorized } from './http.ts';
import { LatencyLog, traceId } from './latency.ts';
import { PairingAuthority } from './pairing-authority.ts';
import type { UpdateActivity } from './update-activity.ts';
import { appOrigin } from '../src/relay-origin.ts';

async function boundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function deviceServer(options: { token: string; origin: string; directory: string;
  transcribe: (wav: Buffer) => Promise<string>; bridgeURL?: string; latency?: LatencyLog; deviceName?: string;
  pairing?: PairingAuthority; appOrigins?: string[]; updateActivity?: UpdateActivity }) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || options.token.length < 32) throw new Error('Invalid device configuration');
  const root = resolve(options.directory);
  const bridgeURL = options.bridgeURL ?? 'http://127.0.0.1:3460';
  const appOrigins = new Set((options.appOrigins ?? []).map(appOrigin));
  let pairingWindow = Date.now(); let pairingAttempts = 0;
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    const json = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data));
    };
    const requestOrigin = request.headers.origin;
    const crossOrigin = requestOrigin !== undefined && requestOrigin !== origin.origin;
    const path = request.url ?? '/';
    // Pair and recovery bootstrap only their own POST routes; no data access.
    // All data routes retain exact-origin checks and session authentication.
    const pairingBootstrap = requestOrigin !== undefined && path === '/api/pair' &&
      ['OPTIONS', 'POST'].includes(request.method ?? '') && !!options.pairing?.allowsPairingOrigin(requestOrigin);
    const resumeBootstrap = requestOrigin !== undefined && path === '/api/pair/resume' &&
      ['OPTIONS', 'POST'].includes(request.method ?? '') && !!options.pairing?.allowsResumeOrigin(requestOrigin);
    if (request.headers.host !== origin.host || (crossOrigin && !appOrigins.has(requestOrigin) && !options.pairing?.allowsOrigin(requestOrigin) && !pairingBootstrap && !resumeBootstrap)) {
      json(403, { error: 'Origin rejected' }); return;
    }
    if (crossOrigin) {
      response.setHeader('Access-Control-Allow-Origin', requestOrigin);
      response.setHeader('Vary', 'Origin');
    }
    try {
      if (path.startsWith('/api/')) {
        const routes = ['/api/status', '/api/messages', '/api/updates', '/api/utterances', '/api/timings', '/api/transcribe', '/api/pair', '/api/pair/resume', '/api/pair/revoke'];
        if (request.method === 'OPTIONS' && crossOrigin) {
          const method = request.headers['access-control-request-method'];
          const headers = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
          if ((pairingBootstrap || resumeBootstrap) && (method !== 'POST' || headers.some(item => item !== 'content-type'))) {
            json(403, { error: 'Pairing preflight rejected' }); return;
          }
          if (!routes.includes(path) || !['GET', 'POST'].includes(String(method)) || headers.some(item => !['authorization', 'content-type', 'x-g2-trace-id', 'x-g2-revision'].includes(item))) {
            json(403, { error: 'Preflight rejected' }); return;
          }
          response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
          response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-G2-Trace-ID, X-G2-Revision');
          response.setHeader('Access-Control-Max-Age', '300');
          response.writeHead(204); response.end(); return;
        }
        if (['/api/pair', '/api/pair/resume'].includes(path) && request.method === 'POST' && options.pairing) {
          if (request.headers['content-type'] !== 'application/json' || requestOrigin === undefined) { json(415, { error: 'JSON and Origin required' }); return; }
          if (Date.now() - pairingWindow >= 60000) { pairingWindow = Date.now(); pairingAttempts = 0; }
          if (++pairingAttempts > 30) { response.setHeader('Retry-After', '60'); json(429, { error: 'Try again later' }); return; }
          const value = JSON.parse((await boundedBody(request, 1024)).toString('utf8'));
          const key = path === '/api/pair/resume' ? 'resumeToken' : 'code';
          if (!value || typeof value[key] !== 'string' || Object.keys(value).length !== 1) { json(400, { error: 'Invalid pairing request' }); return; }
          const result = key === 'resumeToken' ? options.pairing.resume(value.resumeToken, requestOrigin) : options.pairing.exchange(value.code, requestOrigin);
          if (!result) { json(401, { error: 'Pairing invitation invalid or expired' }); return; }
          json(200, result); return;
        }
        const credential = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
        const paired = () => requestOrigin !== undefined && !!options.pairing?.authorized(credential, requestOrigin);
        // The legacy local-device key is accepted only on its existing origin.
        // A beta session never receives the internal bridge/device master key.
        const legacy = !crossOrigin && authorized(request.headers.authorization, options.token);
        if (!legacy && !paired()) { json(401, { error: 'Pairing required' }); return; }
        if (path !== '/api/status') {
          if (options.updateActivity?.maintenance()) { json(503, { error: 'Update in progress' }); return; }
          const finished = options.updateActivity?.begin();
          if (finished) response.once('close', finished);
        }
        if (path === '/api/pair/revoke' && request.method === 'POST' && options.pairing && !legacy) {
          options.pairing.revoke(credential, requestOrigin!); response.writeHead(204); response.end(); return;
        }
        if (path === '/api/transcribe' && request.method === 'POST') {
          if (request.headers['content-type'] !== 'audio/wav') { json(415, { error: 'WAV required' }); return; }
          const rawTrace = request.headers['x-g2-trace-id'];
          const id = rawTrace === undefined ? undefined : traceId.parse(rawTrace);
          const wav = await boundedBody(request, 960044);
          if (id) options.latency?.mark(id, 'asr_received');
          try {
            const text = await options.transcribe(wav);
            if (!legacy && !paired()) { json(401, { error: 'Pairing required' }); return; }
            if (id) options.latency?.mark(id, 'asr_complete');
            json(200, { text }); return;
          } catch (error) { if (id) options.latency?.mark(id, 'asr_failed'); throw error; }
        }
        const allowed = (request.method === 'GET' && ['/api/status', '/api/messages', '/api/updates'].includes(path)) ||
          (request.method === 'POST' && ['/api/utterances', '/api/timings'].includes(path));
        if (!allowed) { json(404, { error: 'Not found' }); return; }
        if (request.method === 'POST' && request.headers['content-type'] !== 'application/json') { json(415, { error: 'JSON required' }); return; }
        const body = request.method === 'POST' ? await boundedBody(request, 32768) : undefined;
        const controller = new AbortController();
        const disconnected = () => controller.abort();
        response.once('close', disconnected);
        try {
          const result = await fetch(`${bridgeURL}${path}`, { method: request.method,
            headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json',
              ...(typeof request.headers['x-g2-revision'] === 'string' ? { 'X-G2-Revision': request.headers['x-g2-revision'] } : {}) },
            body: body?.toString('utf8'), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), redirect: 'error' });
          if (response.destroyed) return;
          if (!legacy && !paired()) { json(401, { error: 'Pairing required' }); return; }
          if (result.status === 204) { response.writeHead(204); response.end(); return; }
          const data = await result.json();
          if (result.ok && options.deviceName) {
            if (path === '/api/status') data.deviceName = options.deviceName;
            if (path === '/api/updates') data.status.deviceName = options.deviceName;
          }
          json(result.status, data); return;
        } finally { response.off('close', disconnected); }
      }
      if (request.method !== 'GET') { json(405, { error: 'GET required' }); return; }
      const decoded = decodeURIComponent(path.split('?')[0]);
      const file = await realpath(resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded)));
      if (!file.startsWith(await realpath(root) + sep)) { json(404, { error: 'Not found' }); return; }
      const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)];
      if (!type) { json(404, { error: 'Not found' }); return; }
      const contents = await readFile(file);
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); response.end(contents);
    } catch { if (!response.destroyed) json(400, { error: '処理できませんでした。接続または録音を確認してください。' }); }
  });
}
