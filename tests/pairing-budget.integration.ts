import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { deviceServer } from '../server/device.ts';

const relay = 'https://mac.tailtest.ts.net';
const source = (n: number) => `http://127.0.0.1:${57000 + n}`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'pairing-budget-'));
  const authority = new PairingAuthority(join(root, 'pairing'));
  const server = deviceServer({ token: 'm'.repeat(43), origin: relay, directory: root, pairing: authority, transcribe: async () => '' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); });
  const post = (path: string, origin: string, body: string) => new Promise<{ status: number; body: any; retry?: string }>((resolve, reject) => {
    const q = request({ host: '127.0.0.1', port: address.port, path, method: 'POST', agent: false,
      headers: { Host: 'mac.tailtest.ts.net', Origin: origin, 'Content-Type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; res.on('data', x => chunks.push(x)); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : undefined, retry: res.headers['retry-after'] as string | undefined });
      });
    });
    q.on('error', reject); q.end(body);
  });
  return { authority, post };
}

test('another peer exhausting the failure budget cannot reject a valid invitation or recovery capability', async t => {
  const { authority, post } = await fixture(t);
  const first = await post('/api/pair', source(1), JSON.stringify({ code: authority.issue(relay).code }));
  assert.equal(first.status, 200);
  const invitation = authority.issue(relay).code;
  // A different peer burns the shared failure budget with guesses and malformed bodies.
  const noise = [];
  for (let n = 0; n < 40; n++) noise.push((await post('/api/pair', source(9), JSON.stringify({ code: 'x'.repeat(43) }))).status);
  assert.deepEqual(noise.slice(0, 30), Array(30).fill(401), 'invalid capabilities keep their existing response within the budget');
  assert.deepEqual(noise.slice(30), Array(10).fill(429));
  const malformed = await post('/api/pair', source(9), '{');
  assert.equal(malformed.status, 429); assert.equal(malformed.retry, '60');
  assert.equal((await post('/api/pair', source(9), JSON.stringify({ code: 'x', extra: 1 }))).status, 429);
  assert.equal((await post('/api/pair/resume', source(9), JSON.stringify({ resumeToken: 'y'.repeat(43) }))).status, 429,
    'an invalid capability is indistinguishable from any other over-budget request');

  const paired = await post('/api/pair', source(2), JSON.stringify({ code: invitation }));
  assert.equal(paired.status, 200, 'valid invitation accepted despite unrelated failures');
  assert.equal(authority.authorized(paired.body.token, source(2)), true);
  const resumed = await post('/api/pair/resume', source(1), JSON.stringify({ resumeToken: first.body.resumeToken }));
  assert.equal(resumed.status, 200, 'valid recovery accepted despite unrelated failures');
  const runtime = await post('/api/pair/resume', source(2), JSON.stringify({ resumeToken: paired.body.resumeToken, runtime: { action: 'inspect' } }));
  assert.equal(runtime.status, 200);
  assert.notEqual((await post('/api/pair', source(9), JSON.stringify({ code: invitation }))).status, 200, 'a consumed invitation stays rejected');
});

test('a client that holds a valid capability is still rate limited per capability', async t => {
  const { authority, post } = await fixture(t);
  const paired = await post('/api/pair', source(1), JSON.stringify({ code: authority.issue(relay).code }));
  const inspect = JSON.stringify({ resumeToken: paired.body.resumeToken, runtime: { action: 'inspect' } });
  const statuses = [];
  for (let n = 0; n < 31; n++) statuses.push((await post('/api/pair/resume', source(1), inspect)).status);
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
  assert.equal(statuses[30], 429);
  const other = await post('/api/pair', source(2), JSON.stringify({ code: authority.issue(relay).code }));
  assert.equal(other.status, 200, "one capability's own loop does not block another device");
});

test('a valid invitation that the handler rejects is still bounded per capability', async t => {
  const { authority, post } = await fixture(t);
  for (let n = 0; n < 16; n++) assert.equal((await post('/api/pair', source(20 + n), JSON.stringify({ code: authority.issue(relay).code }))).status, 200);
  const extra = JSON.stringify({ code: authority.issue(relay).code });
  const statuses = [];
  for (let n = 0; n < 31; n++) statuses.push((await post('/api/pair', source(50), extra)).status);
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(400), 'the device-limit error is unchanged');
  assert.equal(statuses[30], 429, 'repeating it is limited like other uses');
});
