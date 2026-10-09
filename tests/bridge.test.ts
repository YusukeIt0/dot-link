import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { Bridge } from '../server/bridge.ts';
import { authorized, rpc } from '../server/http.ts';
import { WebhookSender, callbackUrl, publicAddress, type Post } from '../server/webhook.ts';

const secret = 'whsec_' + randomBytes(32).toString('base64');
const subscription = {
  name: 'utterance.created', arguments: { session_id: 'personal-g2' },
  delivery: { mode: 'webhook', url: 'https://callback.example.test/events', secret }, cursor: null,
};
function setup(post?: Post) {
  const directory = mkdtempSync(join(tmpdir(), 'g2-bridge-test-'));
  const path = join(directory, 'state.json');
  const events: Record<string, unknown>[] = [];
  const sender = new WebhookSender(post ?? (async (_url, body, headers) => {
    // Validate the wire signature, not just the returned status.
    const decoded = new Webhook(secret).verify(body, headers) as Record<string, unknown>;
    if (decoded.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: decoded.challenge }) };
    events.push(decoded); return { status: 202, body: '{}' };
  }));
  const hosts = ['callback.example.test'];
  return { path, events, sender, hosts, bridge: new Bridge(path, sender, hosts), close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('verified subscription delivers an event and the reply is correlated, persistent, and idempotent', async t => {
  const s = setup(); t.after(s.close);
  await s.bridge.subscribe(subscription);
  const id = randomUUID();
  const message = await s.bridge.submit({ id, text: '接続確認' });
  assert.equal(message.status, 'accepted');
  assert.equal(message.reply, undefined); // HTTP receipt is not a Dot reply.
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0].data, { session_id: 'personal-g2', utterance_id: id, text: '接続確認' });
  assert.deepEqual(s.bridge.pending().utterances.map(item => [item.utterance_id, item.text]), [[id, '接続確認']]);
  await s.bridge.submit({ id, text: '接続確認' });
  assert.equal(s.events.length, 1);
  await assert.rejects(s.bridge.reply({ utterance_id: randomUUID(), text: 'wrong message' }));
  await s.bridge.reply({ utterance_id: id, text: '受信しました' });
  assert.deepEqual(s.bridge.pending().utterances, []);
  await s.bridge.reply({ utterance_id: id, text: '受信しました' });
  await assert.rejects(s.bridge.reply({ utterance_id: id, text: 'overwrite' }));
  const reloaded = new Bridge(s.path, s.sender, s.hosts);
  assert.equal(reloaded.status().subscribed, true);
  assert.equal(reloaded.history()[0].reply, '受信しました');
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
});

test('failed challenge never activates a subscriber and sends no application data', async t => {
  const sent: unknown[] = [];
  const s = setup(async (_url, body) => { sent.push(JSON.parse(body)); return { status: 200, body: '{"challenge":"wrong"}' }; });
  t.after(s.close);
  await assert.rejects(s.bridge.subscribe(subscription));
  await assert.rejects(s.bridge.submit({ id: randomUUID(), text: 'must not leave' }));
  assert.equal(s.bridge.status().subscribed, false);
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { type: string }).type, 'verification');
});

test('session mismatch, second subscriber, unsubscribe, and expiry prevent unintended delivery', async t => {
  const s = setup(); t.after(s.close);
  await assert.rejects(s.bridge.subscribe({ ...subscription, arguments: { session_id: 'someone-else' } }));
  await s.bridge.subscribe(subscription);
  await assert.rejects(s.bridge.subscribe({ ...subscription, delivery: { ...subscription.delivery, url: 'https://callback.example.test/other' } }));
  await s.bridge.unsubscribe({ name: subscription.name, arguments: subscription.arguments, delivery: { mode: 'webhook', url: subscription.delivery.url } });
  await assert.rejects(s.bridge.submit({ id: randomUUID(), text: 'stopped' }));
  await s.bridge.subscribe(subscription);
  const state = JSON.parse(readFileSync(s.path, 'utf8')); state.subscription.expiresAt = 0;
  writeFileSync(s.path, JSON.stringify(state));
  const expired = new Bridge(s.path, s.sender, s.hosts);
  await assert.rejects(expired.submit({ id: randomUUID(), text: 'expired' }));
  assert.equal(s.events.length, 0);
});

test('a webhook timeout remains uncertain and retries with the same ID do not duplicate delivery', async t => {
  let deliveries = 0;
  const s = setup(async (_url, body) => {
    const value = JSON.parse(body);
    if (value.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: value.challenge }) };
    deliveries++; throw new Error('timeout after peer may have received event');
  }); t.after(s.close);
  await s.bridge.subscribe(subscription);
  const input = { id: randomUUID(), text: 'one event' };
  assert.equal((await s.bridge.submit(input)).status, 'failed');
  await s.bridge.submit(input);
  assert.equal(deliveries, 1);
  // A real reply can still arrive after an ambiguous timeout.
  await s.bridge.reply({ utterance_id: input.id, text: 'delayed reply' });
  assert.equal(s.bridge.history()[0].status, 'replied');
});

test('callback validation rejects local destinations, credentials, unlisted hosts, and non-HTTPS', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '::1', '::ffff:192.168.1.1', 'fe80::1', '192.0.2.1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('1.1.1.1'), true);
  for (const url of ['http://callback.example.test/a', 'https://evil.example/a', 'https://user:password@callback.example.test/a', 'https://callback.example.test:444/a']) {
    assert.throws(() => callbackUrl(url, ['callback.example.test']));
  }
  assert.throws(() => callbackUrl('https://callback.example.test/a', []));
});

test('RPC limits tools to status, pending utterances and replies and never exposes secrets', async t => {
  const s = setup(); t.after(s.close);
  const listed = await rpc(s.bridge, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['get_status', 'get_pending_utterances', 'reply_to_g2', 'send_message_to_g2']);
  const status = await rpc(s.bridge, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {}, _meta: { progressToken: 3 } } }) as { result: { structuredContent: unknown } };
  assert.deepEqual(status.result.structuredContent, { subscribed: false, messageCount: 0, sessionId: 'personal-g2' });
  const error = await rpc(s.bridge, { jsonrpc: '2.0', id: 2, method: 'events/subscribe', params: { ...subscription, delivery: { ...subscription.delivery, url: 'https://evil.example/' } } });
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(authorized(`Bearer ${'x'.repeat(32)}`, 'x'.repeat(32)), true);
  assert.equal(authorized('Bearer incorrect', 'x'.repeat(32)), false);
});


test('Dot sends independent follow-ups without a pending utterance or subscription; retries persist once', async t => {
  const s = setup(); t.after(s.close);
  // Load an original version-1 file that has no outbound field.
  writeFileSync(s.path, JSON.stringify({ version: 1, messages: [] }));
  const bridge = new Bridge(s.path, s.sender, s.hosts);
  const first = { message_id: randomUUID(), text: 'Dotからの自発連絡1' };
  const second = { message_id: randomUUID(), text: 'Dotからの自発連絡2' };
  const result = await bridge.sendMessage(first);
  assert.equal(result.stored_for_g2, true);
  assert.equal(result.physical_display_confirmed, false);
  await bridge.sendMessage(second);
  await bridge.sendMessage(first);
  await assert.rejects(bridge.sendMessage({ ...first, text: 'overwrite' }));
  await assert.rejects(bridge.sendMessage({ ...first, utterance_id: randomUUID() }));
  assert.equal(bridge.outboundHistory().length, 2);
  assert.deepEqual(bridge.history(), []);
  assert.deepEqual(bridge.pending().utterances, []);
  assert.equal(s.events.length, 0);
  const reloaded = new Bridge(s.path, s.sender, s.hosts);
  await reloaded.sendMessage(second);
  assert.deepEqual(reloaded.outboundHistory().map(m => m.reply), [first.text, second.text]);
  const viaRpc = await rpc(reloaded, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'send_message_to_g2', arguments: { message_id: randomUUID(), text: 'RPCから3通目' }
  } }) as { result: { structuredContent: { stored_for_g2: boolean } } };
  assert.equal(viaRpc.result.structuredContent.stored_for_g2, true);
  assert.equal(reloaded.outboundHistory().length, 3);
});
