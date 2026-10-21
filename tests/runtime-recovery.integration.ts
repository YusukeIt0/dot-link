import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type ServerResponse } from 'node:http';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { deviceServer } from '../server/device.ts';

const origin = (n: number) => `http://127.0.0.1:${56000 + n}`;
const id = (n: number) => `runtime-${String(n).padStart(16, '0')}`;
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-recovery-http-'));
  const authority = new PairingAuthority(join(root, 'pairing'));
  let held: ServerResponse | undefined;
  let shouldHold = false;
  let onHeld: (() => void) | undefined;
  const bridge = createServer((_request, response) => {
    if (shouldHold) { held = response; shouldHold = false; onHeld?.(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ revision: 'synthetic' }));
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const bridgeAddress = bridge.address(); assert(bridgeAddress && typeof bridgeAddress !== 'string');
  const server = deviceServer({ token: 'm'.repeat(43), origin: 'https://mac.tailtest.ts.net', directory: root,
    pairing: authority, transcribe: async () => 'synthetic', bridgeURL: `http://127.0.0.1:${bridgeAddress.port}` });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections(); bridge.closeAllConnections();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => bridge.close(() => r()))]);
    await rm(root, { recursive: true, force: true });
  });
  const call = (path: string, source: string, method = 'POST', body: unknown = {}, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: any; cors: unknown }>((resolve, reject) => {
      const q = request({ host: '127.0.0.1', port: address.port, path, method, agent: false,
        headers: { Host: 'mac.tailtest.ts.net', Origin: source, 'Content-Type': 'application/json', ...headers } }, res => {
        const chunks: Buffer[] = []; res.on('data', x => chunks.push(x)); res.on('end', () => {
          const raw = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : undefined,
            cors: res.headers['access-control-allow-origin'] });
        });
      });
      q.on('error', reject); q.end(method === 'POST' ? JSON.stringify(body) : undefined);
    });
  const paired = await call('/api/pair', origin(1), 'POST', { code: authority.issue('https://mac.tailtest.ts.net').code });
  assert.equal(paired.status, 200);
  return { authority, call, paired: paired.body,
    hold: () => { shouldHold = true; return new Promise<void>(r => { onHeld = r; }); },
    release: () => { assert(held); held.writeHead(200, { 'Content-Type': 'application/json' }); held.end('{"revision":"synthetic"}'); held = undefined; } };
}

test('HTTP handoff fences stale polls and old recovery without invalidating the new owner', async t => {
  const s = await fixture(t);
  const recover = (source: string, runtime?: unknown) => s.call('/api/pair/resume', source, 'POST', {
    resumeToken: s.paired.resumeToken, ...(runtime ? { runtime } : {}),
  });
  const inspect = await recover(origin(1), { action: 'inspect' });
  assert.deepEqual(inspect.body, { protocol: 1, generation: 0 });
  assert.equal(s.authority.authorized(s.paired.token, origin(1)), true, 'inspection does not replace access');
  const first = await recover(origin(1), { action: 'claim', id: id(1), expectedGeneration: 0 });
  assert.equal(first.status, 200);
  const reached = s.hold();
  const oldPoll = s.call('/api/updates', origin(1), 'GET', {}, { Authorization: `Bearer ${first.body.token}` });
  await reached;
  const second = await recover(origin(2), { action: 'claim', id: id(2), expectedGeneration: 1 });
  assert.equal(second.status, 200);
  s.release();
  assert.equal((await oldPoll).status, 401, 'a response cannot cross an ownership change');
  const stale = await recover(origin(1), { action: 'renew', id: id(1), generation: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'runtime_superseded'); assert.equal(stale.cors, origin(1));
  for (let n = 0; n < 35; n++) assert.equal((await recover(origin(1))).status, 409, 'old code cannot reclaim or exhaust acquisition rate budget');
  const retry = await recover(origin(2), { action: 'claim', id: id(2), expectedGeneration: 1 });
  assert.deepEqual(retry.body, second.body);
  assert.equal((await s.call('/api/updates', origin(2), 'GET', {}, { Authorization: `Bearer ${second.body.token}` })).status, 200);
  assert.equal((await s.call('/api/utterances', origin(1), 'POST', {}, { Authorization: `Bearer ${first.body.token}` })).status, 403);
  assert.equal((await s.call('/api/pair/revoke', origin(2), 'POST', {}, { Authorization: `Bearer ${second.body.token}` })).status, 204);
  assert.equal((await recover(origin(2), { action: 'inspect' })).status, 401);
});

test('runtime negotiation preserves bootstrap CORS and rejects malformed or unauthorized ownership requests', async t => {
  const s = await fixture(t);
  const preflight = await s.call('/api/pair/resume', origin(2), 'OPTIONS', {}, {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
  });
  assert.equal(preflight.status, 204); assert.equal(preflight.cors, origin(2));
  for (const runtime of [{ action: 'inspect', extra: true }, { action: 'claim', id: id(2), expectedGeneration: -1 },
    { action: 'renew', id: id(2), generation: 0 }, { action: 'claim', id: 'short', expectedGeneration: 0 }]) {
    assert.equal((await s.call('/api/pair/resume', origin(2), 'POST', { resumeToken: s.paired.resumeToken, runtime })).status, 400);
  }
  const body = { resumeToken: s.paired.resumeToken, runtime: { action: 'inspect' } };
  assert.equal((await s.call('/api/pair/resume', 'https://evil.example', 'POST', body)).status, 403);
  assert.equal((await s.call('/api/pair/resume', origin(2), 'POST', { ...body, extra: true })).status, 400);
  assert.equal((await s.call('/api/pair/resume', origin(2), 'POST', { ...body, resumeToken: 'x'.repeat(43) })).status, 401);
  assert.equal((await s.call('/api/pair/resume', origin(1), 'POST', { resumeToken: s.paired.resumeToken })).status, 200, 'legacy recovery remains before adoption');
});
