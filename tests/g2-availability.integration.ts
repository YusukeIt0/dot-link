import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Bridge } from '../server/bridge.ts';
import { bridgeServer } from '../server/http.ts';
import { deviceServer } from '../server/device.ts';
import { WebhookSender } from '../server/webhook.ts';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { G2DeliveryAvailability } from '../server/g2-availability.ts';
import { GlassesAvailability } from '../src/g2-availability.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  return address.port;
}

test('paired companion answers the Mac long-poll challenge, with fresh hardware, only for its live runtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dot-availability-'));
  const pairing = new PairingAuthority(join(root, 'pairing'));
  const mac = new G2DeliveryAvailability((owner, runtime) => pairing.currentRuntime(owner, runtime));
  const bridge = new Bridge(join(root, 'bridge.json'), new WebhookSender(async () => {throw Error('unexpected webhook');}), []);
  const tokens = {mcp: 'm'.repeat(43), device: 'd'.repeat(43)};
  const relay = bridgeServer(bridge, tokens, undefined, undefined, undefined, undefined, undefined, undefined, undefined, mac);
  const relayPort = await listen(relay);
  const host = 'mac.tailtest.ts.net', origin = 'http://127.0.0.1:55123';
  const gateway = deviceServer({origin: `https://${host}`, directory: root, token: tokens.device, pairing,
    bridgeURL: `http://127.0.0.1:${relayPort}`, transcribe: async () => ''});
  const port = await listen(gateway);
  t.after(async () => {
    for (const server of [gateway, relay]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await rm(root, {recursive: true, force: true});
  });
  const call = (path: string, headers: Record<string,string> = {}, body?: unknown) =>
    new Promise<{status: number; value: any}>((resolve, reject) => {
      const req = request({host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
        headers: {Host: host, Origin: origin, 'Content-Type': 'application/json', ...headers}}, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({status: res.statusCode!, value: raw ? JSON.parse(raw) : undefined});
        });
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });

  const initial = await call('/api/pair', {}, {code: pairing.issue(`https://${host}`).code});
  assert.equal(initial.status, 200);
  const claim = (expectedGeneration: number) => call('/api/pair/resume', {}, {resumeToken: initial.value.resumeToken,
    runtime: {action: 'claim', expectedGeneration, id: `runtime-fixture-${expectedGeneration}`}});
  const current = await claim(0);
  assert.equal(current.status, 200);
  const headers = {Authorization: `Bearer ${current.value.token}`};
  const first = await call('/api/updates', headers);
  assert.equal(first.status, 200); assert.equal(first.value.availabilityChallenge, undefined);
  const phone = new GlassesAvailability();
  const decision = mac.check();
  const poll = await call('/api/updates', {...headers, 'X-G2-Revision': first.value.revision});
  assert.equal(poll.status, 200);
  const challenge = poll.value.availabilityChallenge;
  assert.deepEqual(Object.keys(challenge), ['id']);
  await phone.answer(challenge, () => phone.read({callEvenApp: async () => ({model:'g2',
    status:{connectType:'connected', isWearing:true, isInCase:false}})}), () => true, async (id, state) => {
    const response = await call('/api/g2-availability', headers, {id, state});
    assert.deepEqual(response, {status:200, value:{accepted:true}});
  });
  const live = await decision; assert.equal(live.state(), 'available');
  assert.equal((await call('/api/g2-availability', headers, {...challenge, state:'available'})).status, 409);

  const next = await claim(1);
  assert.equal(next.status, 200);
  assert.equal(live.state(), 'unknown');
  assert.equal((await call('/api/g2-availability', headers, {...challenge, state:'available'})).status, 401);
  const nextHeaders = {Authorization: `Bearer ${next.value.token}`};
  await call('/api/updates', nextHeaders);
  assert.equal((await call('/api/g2-availability', nextHeaders, {...challenge, state:'available'})).status, 409);
  const reopened = new GlassesAvailability();
  for (const [inCase, expected] of [[true, 'unavailable'], [false, 'available']] as const) {
    const pending = mac.check();
    const offered = (await call('/api/updates', nextHeaders)).value.availabilityChallenge;
    await reopened.answer(offered, () => reopened.read({callEvenApp: async () => ({
      model: 'g2', status: {connectType: 'connected', isWearing: false, isInCase: inCase, isCharging: false},
    })}), () => true, async (id, state) => {
      assert.equal((await call('/api/g2-availability', nextHeaders, {id, state})).status, 200);
    });
    assert.equal((await pending).state(), expected);
  }
  const stored = await call('/api/messages', nextHeaders); assert.deepEqual(stored.value, []);
});
