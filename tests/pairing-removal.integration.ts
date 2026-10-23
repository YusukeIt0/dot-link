import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { UpdateActivity } from '../server/update-activity.ts';
import { deviceServer } from '../server/device.ts';
import { removeEvenPairings } from '../scripts/lib/pairing-removal.mjs';

test('Mac removal reaches an already-running relay: readable denial, no recovery, fresh pairing, and truthful failed revoke', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-remove-http-'));
  const pairingRoot = join(directory, '.runtime/pairing');
  const pairing = new PairingAuthority(pairingRoot);
  const updateActivity = new UpdateActivity(directory);
  t.after(() => updateActivity.close());
  const host = 'fixture.tailtest.ts.net', origin = 'http://127.0.0.1:55501';
  const servers: Server[] = [];
  t.after(async () => {
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function listen(server: Server) {
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert(address && typeof address !== 'string'); return address.port;
  }
  let bridgeCalls = 0;
  const bridge = createServer((_req, res) => { bridgeCalls++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"fixture":true}'); });
  const bridgePort = await listen(bridge);
  const port = await listen(deviceServer({ token: 'm'.repeat(43), origin: `https://${host}`, directory, pairing, updateActivity,
    bridgeURL: `http://127.0.0.1:${bridgePort}`, transcribe: async () => 'fixture' }));
  const invoke = (path: string, method = 'GET', headers: Record<string, string> = {}, body = '') =>
    new Promise<{ status: number; allowOrigin?: string; text: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: host, Origin: origin, ...headers } }, res => {
        let text = ''; res.on('data', chunk => text += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, allowOrigin: res.headers['access-control-allow-origin'], text }));
      });
      req.on('error', reject); req.end(body);
    });
  const invite = pairing.issue(`https://${host}`);
  const old = pairing.exchange(invite.code, origin)!;
  const auth = { Authorization: `Bearer ${old.token}` };
  assert.equal((await invoke('/api/status', 'GET', auth)).status, 200);
  const unused = pairing.issue(`https://${host}`);
  assert.equal((await removeEvenPairings(directory)).pairingRemoval, 'removed');
  const before = bridgeCalls;
  for (const path of ['/api/status', '/api/updates']) {
    const preflight = await invoke(path, 'OPTIONS', { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,x-g2-revision' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.allowOrigin, origin);
    const denied = await invoke(path, 'GET', auth);
    assert.equal(denied.status, 401);
    assert.equal(denied.allowOrigin, origin);
    assert.equal(denied.text.includes('fixture'), false);
  }
  assert.equal(bridgeCalls, before, 'revoked requests never reach the bridge');
  assert.equal((await invoke('/api/status', 'GET', { ...auth, Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await invoke('/api/status', 'GET', { Authorization: 'Bearer ' + 'm'.repeat(43) })).status, 401, 'legacy key is not accepted cross-origin');
  assert.equal((await invoke('/api/pair/resume', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ resumeToken: old.resumeToken }))).status, 401);
  assert.equal(pairing.exchange(unused.code, origin), undefined);
  const fresh = pairing.exchange(pairing.issue(`https://${host}`).code, origin)!;
  const freshAuth = { Authorization: `Bearer ${fresh.token}` };
  assert.equal((await invoke('/api/status', 'GET', freshAuth)).status, 200);
  const changedOrigin = 'http://127.0.0.1:55502';
  const proof = { 'Content-Type': 'application/json', Origin: changedOrigin };
  const envelope = JSON.stringify({ resumeToken: fresh.resumeToken });
  const preflight = await invoke('/api/pair/revoke', 'OPTIONS', { Origin: changedOrigin,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
  assert.equal(preflight.status, 204);
  assert.equal((await invoke('/api/pair/revoke', 'POST', { ...proof, Origin: 'https://untrusted.example' }, envelope)).status, 403);
  assert.equal((await invoke('/api/pair/revoke', 'POST', proof, JSON.stringify({ resumeToken: 'bad' }))).status, 400);
  assert.equal(pairing.authorized(fresh.token, origin), true);
  assert.equal((await invoke('/api/pair/revoke', 'POST', proof, envelope)).status, 204);
  assert.equal((await invoke('/api/pair/revoke', 'POST', proof, envelope)).status, 204, 'lost response retry');
  assert.equal((await invoke('/api/status', 'GET', freshAuth)).status, 401);
  assert.equal((await invoke('/api/pair/resume', 'POST', proof, envelope)).status, 401);
  const last = pairing.exchange(pairing.issue(`https://${host}`).code, origin)!;
  let reachedGate!: () => void;
  const gated = new Promise<void>(resolve => { reachedGate = resolve; });
  const originalMaintenance = updateActivity.maintenance.bind(updateActivity);
  const gate = t.mock.method(updateActivity, 'maintenance', () => { reachedGate(); return originalMaintenance(); });
  let finishBody!: () => void;
  const delayed = new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/pair/revoke', method: 'POST',
      headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.write('{');
    finishBody = () => req.end(`"resumeToken":"${last.resumeToken}"}`);
  });
  await gated;
  await writeFile(join(directory, 'app-update.json'), '{}');
  finishBody();
  assert.equal(await delayed, 503, 'maintenance starting during body read blocks the write');
  assert.equal(pairing.authorized(last.token, origin), true);
  await rm(join(directory, 'app-update.json'));
  gate.mock.restore();
  t.mock.method(pairing, 'revoke', () => false);
  assert.equal((await invoke('/api/pair/revoke', 'POST', { Authorization: `Bearer ${last.token}` })).status, 500);
  assert.equal(pairing.authorized(last.token, origin), true);
});
