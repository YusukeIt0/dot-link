import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Bridge } from '../server/bridge.ts';
import { bridgeServer } from '../server/http.ts';
import { WebhookSender } from '../server/webhook.ts';
import { NotificationInbox } from '../server/notifications.ts';

test('real HTTP listener separates device and MCP credentials and rejects browser-origin requests', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-http-test-'));
  const bridge = new Bridge(join(directory, 'state.json'), new WebhookSender(async () => { throw new Error('No outgoing requests allowed in this test'); }), []);
  const tokens = { mcp: randomBytes(32).toString('hex'), device: randomBytes(32).toString('hex') };
  const server = bridgeServer(bridge, tokens);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await fetch(base + '/mcp')).status, 401);
  assert.equal((await fetch(base + '/api/messages')).status, 401);
  assert.equal((await fetch(base + '/api/messages', { headers: { Authorization: `Bearer ${tokens.mcp}` } })).status, 401);
  const discovery = { method: 'POST', headers: { Authorization: `Bearer ${tokens.mcp}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) };
  const response = await fetch(base + '/mcp', discovery);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result.supportedVersions, ['2026-07-28']);
  assert.equal((await fetch(base + '/mcp', { ...discovery, headers: { ...discovery.headers, Authorization: `Bearer ${tokens.device}` } })).status, 401);
  assert.equal((await fetch(base + '/mcp', { ...discovery, headers: { ...discovery.headers, Origin: 'https://unexpected.example' } })).status, 403);
  const status = await fetch(base + '/api/status', { headers: { Authorization: `Bearer ${tokens.device}` } });
  assert.deepEqual(await status.json(), { subscribed: false, messageCount: 0, sessionId: 'personal-g2' });
  const timingBody = JSON.stringify({ id: randomUUID(), events: [{ stage: 'reply_received', at: Date.now(), elapsedMs: 0 }] });
  for (const key of [tokens.mcp, 'invalid']) assert.equal((await fetch(base + '/api/timings', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: timingBody })).status, 401);
  assert.equal((await fetch(base + '/api/timings', { method: 'POST', headers: { Authorization: `Bearer ${tokens.device}` }, body: timingBody })).status, 204);
  assert.equal((await fetch(base + '/api/timings', { method: 'POST', headers: { Authorization: `Bearer ${tokens.device}` }, body: '{"text":"not a timing"}' })).status, 400);
  const outgoing = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_message_to_g2', arguments: { message_id: randomUUID(), text: 'Dotから自発連絡' } } };
  const sendOptions = { ...discovery, body: JSON.stringify(outgoing) };
  assert.equal((await fetch(base + '/mcp', { ...sendOptions, headers: { ...sendOptions.headers, Authorization: `Bearer ${tokens.device}` } })).status, 401);
  for (let i = 0; i < 2; i++) {
    const sent = await fetch(base + '/mcp', sendOptions);
    assert.equal((await sent.json()).result.structuredContent.stored_for_g2, true);
  }
  const rows = await (await fetch(base + '/api/messages', { headers: { Authorization: `Bearer ${tokens.device}` } })).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'proactive');
  assert.equal(rows[0].reply, 'Dotから自発連絡');
  assert.deepEqual(bridge.pending().utterances, []);
  const invalid = await fetch(base + '/mcp', { ...discovery, body: '{' });
  assert.equal(invalid.status, 400);
});

test('notification ingestion requires its own key and only Dot announcements enter the G2 timeline', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-notify-http-'));
  const sender = new WebhookSender(async (_url, body) => {
    const value = JSON.parse(body);
    return { status: 200, body: JSON.stringify(value.type === 'verification' ? { challenge: value.challenge } : {}) };
  });
  const bridge = new Bridge(join(directory, 'voice.json'), sender, ['callback.example.test']);
  const inbox = new NotificationInbox(join(directory, 'notifications.json'), sender, ['callback.example.test']);
  const tokens = { mcp: randomBytes(32).toString('hex'), device: randomBytes(32).toString('hex'), notification: randomBytes(32).toString('hex') };
  const server = bridgeServer(bridge, tokens, inbox);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, key: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const n = { id: randomUUID(), source_app: 'Test', title: 'Synthetic', body: 'Body', observed_at: new Date().toISOString(), source_verification: 'synthetic-test-marker' };
  for (const key of [tokens.mcp, tokens.device, 'incorrect']) assert.equal((await post('/api/notifications', key, n)).status, 401);
  assert.equal((await post('/mcp', tokens.notification, {})).status, 401);
  assert.equal((await post('/api/utterances', tokens.notification, { id: randomUUID(), text: 'not allowed' })).status, 401);
  assert.equal((await post('/api/notifications', tokens.notification, n)).status, 400); // No subscriber yet.
  await inbox.subscribe({ name: 'notification.created', arguments: { session_id: 'personal-g2' }, delivery: { mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64') } });
  assert.equal((await post('/api/notifications', tokens.notification, n)).status, 200);
  const history = () => fetch(base + '/api/messages', { headers: { Authorization: `Bearer ${tokens.device}` } }).then(r => r.json());
  assert.deepEqual(await history(), []);
  const reply = await post('/mcp', tokens.mcp, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'announce_notification_to_g2', arguments: { notification_id: n.id, text: '通知です' } } });
  assert.equal((await reply.json()).result.structuredContent.stored_for_g2, true);
  assert.equal((await history())[0].kind, 'notification');
  for (const key of [tokens.mcp, tokens.device, 'incorrect']) assert.equal((await post('/api/notifications/status', key, { ids: [n.id] })).status, 401);
  const status = await post('/api/notifications/status', tokens.notification, { ids: [n.id] }).then(r => r.json());
  assert.equal(status.notifications[0].status, 'announced');
  assert.ok(status.notifications[0].client_response_at);
  assert.equal(JSON.stringify(status).includes('Synthetic'), false);
  assert.equal(JSON.stringify(status).includes('Body'), false);
  assert.equal((await post('/api/notifications/status', tokens.notification, { ids: [n.id], text: 'forbidden' })).status, 400);
  assert.equal((await fetch(base + '/api/notifications/status', {method: 'POST', headers: {Authorization: `Bearer ${tokens.notification}`, Origin: 'https://example.test'}, body: JSON.stringify({ids:[n.id]})})).status, 403);
  assert.deepEqual(bridge.history(), []);
});
