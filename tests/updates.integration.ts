import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../server/bridge.ts';
import { bridgeServer } from '../server/http.ts';
import { NotificationInbox } from '../server/notifications.ts';
import { deviceServer } from '../server/device.ts';
import { WebhookSender } from '../server/webhook.ts';

// Native HTTP permits an explicit Host header like Tailscale Serve forwards.
async function fetch(url: string, options: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, options, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode! })));
    });
    req.on('error', reject); req.end();
  });
}

// Exercises the actual two HTTP servers. No Dot substitute is used for an
// end-to-end claim: only delivery plumbing is tested here, with fixture text.
test('waiting device receives voice replies, notifications and proactive messages immediately; disconnects release capacity', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-updates-'));
  writeFileSync(join(dir, 'index.html'), 'test');
  const sender = new WebhookSender(async (_url, body) => {
    const value = JSON.parse(body);
    return { status: 200, body: JSON.stringify(value.type === 'verification' ? { challenge: value.challenge } : {}) };
  });
  const bridge = new Bridge(join(dir, 'voice.json'), sender, ['callback.example']);
  const inbox = new NotificationInbox(join(dir, 'notifications.json'), sender, ['callback.example']);
  const tokens = { mcp: randomBytes(32).toString('hex'), device: randomBytes(32).toString('hex'), notification: randomBytes(32).toString('hex') };
  const inner = bridgeServer(bridge, tokens, inbox);
  inner.listen(0, '127.0.0.1'); await once(inner, 'listening');
  const address = inner.address(); assert(address && typeof address !== 'string');
  const innerURL = `http://127.0.0.1:${address.port}`;
  const outer = deviceServer({ origin: 'http://g2.example', directory: dir, token: tokens.device, bridgeURL: innerURL, deviceName: '別のMac', transcribe: async () => 'unused' });
  outer.listen(0, '127.0.0.1'); await once(outer, 'listening');
  const oa = outer.address(); assert(oa && typeof oa !== 'string');
  const base = `http://127.0.0.1:${oa.port}`;
  t.after(async () => {
    for (const server of [outer, inner]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    rmSync(dir, { recursive: true, force: true });
  });
  const headers = { Host: 'g2.example', Origin: 'http://g2.example', Authorization: `Bearer ${tokens.device}` };
  const get = (revision?: string, signal?: AbortSignal) => fetch(base + '/api/updates', { headers: { ...headers, ...(revision ? { 'X-G2-Revision': revision } : {}) }, signal });
  assert.equal((await fetch(innerURL + '/api/updates', { headers: { Authorization: `Bearer ${tokens.mcp}` } })).status, 401);
  assert.equal((await fetch(base + '/api/updates', { headers: { ...headers, Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/status', { headers: { ...headers, Authorization: 'Bearer invalid' } })).status, 401);
  const named = await (await fetch(base + '/api/status', { headers })).json();
  assert.equal(named.deviceName, '別のMac');
  assert.equal((await get('bad cursor')).status, 400);
  let state = await (await get()).json();
  assert.deepEqual(state.messages, []);
  assert.equal(state.status.subscribed, false);
  assert.equal(state.status.deviceName, '別のMac');
  const delivery = { mode: 'webhook', url: 'https://callback.example/events', secret: 'whsec_' + randomBytes(32).toString('base64') };
  await bridge.subscribe({ name: 'utterance.created', arguments: { session_id: 'personal-g2' }, delivery });
  const id = randomUUID(); await bridge.submit({ id, text: 'fixture voice' });
  state = await (await get()).json();
  let settled = false;
  const waiting = get(state.revision).then(r => { settled = true; return r.json(); });
  await delay(40); assert.equal(settled, false);
  const repliedAt = performance.now();
  await bridge.reply({ utterance_id: id, text: 'fixture reply' });
  state = await waiting;
  assert(performance.now() - repliedAt < 1000, 'must wake without a three-second poll');
  assert.equal(state.messages[0].reply, 'fixture reply');
  // Same UUID+text is idempotent and should not trigger repeated updates.
  settled = false;
  const duplicateWait = get(state.revision).then(r => { settled = true; return r.json(); });
  await bridge.reply({ utterance_id: id, text: 'fixture reply' }); await delay(40);
  assert.equal(settled, false);
  await bridge.sendMessage({ message_id: randomUUID(), text: 'fixture follow-up' });
  state = await duplicateWait;
  assert.equal(state.messages.at(-1).kind, 'proactive');
  await inbox.subscribe({ name: 'notification.created', arguments: { session_id: 'personal-g2' }, delivery });
  const notificationId = randomUUID();
  await inbox.submit({ id: notificationId, title: 'fixture title', body: 'fixture body', source_app: 'Test', observed_at: new Date().toISOString(), source_verification: 'synthetic-test-marker' });
  state = await (await get()).json();
  assert.equal(state.messages.length, 2);
  const announcementWait = get(state.revision).then(r => r.json());
  await inbox.announce({ notification_id: notificationId, text: 'fixture announcement' });
  state = await announcementWait;
  assert.equal(state.messages.at(-1).kind, 'notification');
  // Aborted outer requests must cancel their inner wait, otherwise the cap is
  // exhausted after a few reconnects (including iPhone foreground/background).
  for (let i = 0; i < 10; i++) {
    const controller = new AbortController();
    const request = get(state.revision, controller.signal).catch(() => undefined);
    await delay(15); controller.abort(); await request; await delay(15);
  }
  const reconnect = get(state.revision);
  await delay(30);
  await bridge.sendMessage({ message_id: randomUUID(), text: 'fixture reconnect' });
  const response = await reconnect;
  assert.equal(response.status, 200); assert.equal((await response.json()).messages.at(-1).reply, 'fixture reconnect');
  const oldInstance = `${randomUUID()}:0`;
  assert.equal((await get(oldInstance)).status, 200); // Restart changes revision namespace.
});
