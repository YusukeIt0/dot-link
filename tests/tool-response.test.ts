import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { Bridge } from '../server/bridge.ts';
import { NotificationInbox } from '../server/notifications.ts';
import { rpc } from '../server/http.ts';
import { toolFixture } from './tool-response-fixture.ts';

function rejection(response: any, reason: string, excluded: string[] = []) {
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 7);
  assert.equal(response.error?.code, reason === 'internal_error' ? -32603 : -32602);
  assert.deepEqual(response.error.data, { reason });
  assert.equal(response.result, undefined);
  assert.equal(typeof response.error.message, 'string');
  for (const value of excluded) assert(!JSON.stringify(response).includes(value), 'Response must not expose supplied values');
}

test('reply and proactive reasons preserve success payloads and identical retries', async t => {
  const f = await toolFixture(t);
  const missing = randomUUID();
  const text = 'PRIVATE fixture reply';
  rejection(await f.call('reply_to_g2', { utterance_id: missing, text }), 'utterance_unknown', [missing, text]);
  const args = { utterance_id: f.utterance, text };
  const reply = await f.call('reply_to_g2', args);
  assert.deepEqual(reply.result.structuredContent, { utterance_id: f.utterance, delivered_to_bridge: true });
  assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent);
  assert.deepEqual(await f.call('reply_to_g2', args), reply);
  rejection(await f.call('reply_to_g2', { ...args, text: 'PRIVATE conflicting reply' }), 'reply_conflict', [f.utterance, text, 'PRIVATE']);
  assert.equal(f.bridge.history()[0].reply, text);

  const message = { message_id: randomUUID(), text: 'PRIVATE proactive fixture' };
  const sent = await f.call('send_message_to_g2', message);
  assert.deepEqual(sent.result.structuredContent, { message_id: message.message_id, stored_for_g2: true, physical_display_confirmed: false });
  assert.deepEqual(await f.call('send_message_to_g2', message), sent);
  rejection(await f.call('send_message_to_g2', { ...message, text: 'PRIVATE conflicting message' }), 'message_id_conflict', [message.message_id, 'PRIVATE']);
  assert.equal(f.bridge.outboundHistory().length, 1);
  assert.equal(f.bridge.outboundHistory()[0].reply, message.text);
  const reload = new Bridge(f.bridgePath, f.sender, f.hosts); t.after(() => reload.close());
  assert.equal(reload.history()[0].reply, text);
  assert.equal(reload.outboundHistory()[0].reply, message.text);
});

test('notification reasons preserve decisions, announcements and identical retries', async t => {
  const f = await toolFixture(t);
  const unknown = randomUUID();
  for (const [name, args] of [
    ['announce_notification_to_g2', { notification_id: unknown, text: 'PRIVATE announcement' }],
    ['set_notification_disposition', { notification_id: unknown, disposition: 'silent' }],
  ] as const) rejection(await f.call(name, args), 'notification_unknown', [unknown, 'PRIVATE']);

  const silent = await f.notification();
  const decision = { notification_id: silent, disposition: 'silent' };
  const decided = await f.call('set_notification_disposition', decision);
  assert.deepEqual(decided.result.structuredContent, { ...decision, stored_for_g2: false, wakeup_scheduled: false });
  assert.deepEqual(await f.call('set_notification_disposition', decision), decided);
  rejection(await f.call('announce_notification_to_g2', { notification_id: silent, text: 'PRIVATE silent bypass' }), 'notification_silent', [silent, 'PRIVATE']);
  assert.equal(f.inbox.history().length, 0);

  const id = await f.notification();
  await f.call('set_notification_disposition', { notification_id: id, disposition: 'later' });
  const args = { notification_id: id, text: 'PRIVATE accepted announcement' };
  const announced = await f.call('announce_notification_to_g2', args);
  assert.deepEqual(announced.result.structuredContent, { notification_id: id, stored_for_g2: true });
  assert.deepEqual(JSON.parse(announced.result.content[0].text), announced.result.structuredContent);
  assert.deepEqual(await f.call('announce_notification_to_g2', args), announced);
  rejection(await f.call('announce_notification_to_g2', { ...args, text: 'PRIVATE conflicting announcement' }), 'announcement_conflict', [id, 'PRIVATE']);
  for (const disposition of ['silent', 'later']) rejection(await f.call('set_notification_disposition', { notification_id: id, disposition }), 'notification_already_announced', [id]);
  assert.equal(f.inbox.history().length, 1);
  assert.equal(f.inbox.history()[0].reply, args.text);
  assert.equal(f.inbox.deliveryStatus({ ids: [id] }).notifications[0].disposition, undefined);
  const reload = new NotificationInbox(f.notificationPath, f.sender, f.hosts);
  assert.equal(reload.history()[0].reply, args.text);
  assert.equal(reload.deliveryStatus({ ids: [silent] }).notifications[0].disposition, 'silent');
});

test('only caller argument validation becomes invalid_arguments, including absent arguments', async t => {
  const f = await toolFixture(t);
  const id = randomUUID(), privateValue = 'PRIVATE https://private.invalid/token';
  const cases = [
    { name: 'reply_to_g2', valid: { utterance_id: id, text: 'fixture' }, field: 'utterance_id' },
    { name: 'send_message_to_g2', valid: { message_id: id, text: 'fixture' }, field: 'message_id' },
    { name: 'announce_notification_to_g2', valid: { notification_id: id, text: 'fixture' }, field: 'notification_id' },
    { name: 'set_notification_disposition', valid: { notification_id: id, disposition: 'later' }, field: 'notification_id' },
  ];
  for (const { name, valid, field } of cases) {
    const invalid: unknown[] = [undefined, null, [], privateValue, {}, { ...valid, [field]: privateValue }, { ...valid, extra: privateValue }];
    if (name === 'set_notification_disposition') invalid.push({ ...valid, disposition: privateValue });
    else for (const text of ['', ' ', null, 5, 'x'.repeat(8001)]) invalid.push({ ...valid, text });
    for (const args of invalid) rejection(await f.call(name, args), 'invalid_arguments', [privateValue, id]);
    const missing = await rpc(f.bridge, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, _meta: { progressToken: 1 } } }, f.inbox);
    rejection(missing, 'invalid_arguments', [id]);
  }
  assert.equal(f.bridge.history()[0].reply, undefined);
  assert.equal(f.bridge.outboundHistory().length, 0);
  assert.equal(f.inbox.history().length, 0);
});

test('unknown, disabled and malformed tools expose routing or argument reasons', async t => {
  const f = await toolFixture(t);
  for (const [name, args, inbox] of [
    ['unknown_tool', {}, f.inbox], ['get_status', { extra: true }, f.inbox],
    ['get_pending_utterances', { extra: true }, f.inbox], ['get_pending_notifications', { extra: true }, f.inbox],
    ['announce_notification_to_g2', {}, undefined], ['set_notification_disposition', {}, undefined],
  ] as const) {
    const result = await rpc(f.bridge, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, inbox) as any;
    rejection(result, name === 'unknown_tool' ? 'unknown_tool' : !inbox ? 'tool_unavailable' : 'invalid_arguments');
  }
});

test('execution errors, including Zod and lookalike reasons, use a fixed internal_error', async t => {
  const f = await toolFixture(t);
  const id = await f.notification();
  const privateValue = 'PRIVATE exception /private/path token';
  const validation = z.literal('expected').safeParse(privateValue);
  assert(!validation.success);
  for (const error of [new Error(privateValue), validation.error, { reason: 'reply_conflict', message: privateValue }]) {
    for (const [owner, method, name, args] of [
      [f.bridge, 'reply', 'reply_to_g2', { utterance_id: f.utterance, text: 'fixture' }],
      [f.bridge, 'sendMessage', 'send_message_to_g2', { message_id: randomUUID(), text: 'fixture' }],
      [f.inbox, 'announce', 'announce_notification_to_g2', { notification_id: id, text: 'fixture' }],
      [f.inbox, 'decide', 'set_notification_disposition', { notification_id: id, disposition: 'silent' }],
    ] as const) {
      const mock = t.mock.method(owner as any, method, async () => { throw error; });
      rejection(await f.call(name, args), 'internal_error', [privateValue, id, f.utterance]);
      mock.mock.restore();
    }
  }
});

for (const failure of ['write', 'rename'] as const) {
  for (const name of ['reply_to_g2', 'send_message_to_g2', 'announce_notification_to_g2', 'set_notification_disposition'] as const) {
    test(`${name} ${failure} failure does not publish unsaved state and identical retry persists`, async t => {
      const f = await toolFixture(t);
      const id = await f.notification();
      const message = randomUUID();
      const args = name === 'reply_to_g2' ? { utterance_id: f.utterance, text: 'fixture reply' }
        : name === 'send_message_to_g2' ? { message_id: message, text: 'fixture proactive' }
        : name === 'announce_notification_to_g2' ? { notification_id: id, text: 'fixture announcement' }
        : { notification_id: id, disposition: 'silent' };
      const notification = name.includes('notification');
      const path = notification ? f.notificationPath : f.bridgePath;
      const before = readFileSync(path, 'utf8');
      const beforeHistory = notification ? f.inbox.history() : [f.bridge.history(), f.bridge.outboundHistory()];
      let changed = 0;
      const unsubscribe = (notification ? f.inbox : f.bridge).changes.subscribe(() => changed++);
      if (failure === 'write') mkdirSync(`${path}.tmp`);
      else { renameSync(path, `${path}.before`); mkdirSync(path); }
      try {
        rejection(await f.call(name, args), 'internal_error', [path, id, message, 'fixture']);
        assert.equal(changed, 0);
        assert.deepEqual(notification ? f.inbox.history() : [f.bridge.history(), f.bridge.outboundHistory()], beforeHistory);
        assert.equal(f.inbox.deliveryStatus({ ids: [id] }).notifications[0].disposition, undefined);
      } finally {
        if (failure === 'write') rmSync(`${path}.tmp`, { recursive: true });
        else { rmSync(path, { recursive: true }); renameSync(`${path}.before`, path); }
      }
      assert.equal(readFileSync(path, 'utf8'), before);
      const retried = await f.call(name, args);
      assert(retried.result);
      assert.deepEqual(await f.call(name, args), retried);
      assert.notEqual(readFileSync(path, 'utf8'), before);
      const bridge = new Bridge(f.bridgePath, f.sender, f.hosts); t.after(() => bridge.close());
      const inbox = new NotificationInbox(f.notificationPath, f.sender, f.hosts);
      const afterRestart = await rpc(bridge, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, inbox);
      assert.deepEqual(afterRestart, retried);
      unsubscribe();
    });
  }
}

test('location bridge conflicts stay inside the location error contract', async t => {
  const f = await toolFixture(t);
  const sharing = randomUUID(), owner = 'a'.repeat(64);
  f.location.control({ sharing_id: sharing, enabled: true }, owner);
  f.location.update({ sharing_id: sharing, sequence: 1, fix: { latitude: 10, longitude: 20, accuracy: 5, measured_at: new Date().toISOString() } }, owner);
  const id = f.location.read().context!.context_id;
  await f.bridge.sendMessage({ message_id: id, text: 'PRIVATE existing message' });
  const response = await f.call('respond_to_location', { context_id: id, disposition: 'announce', text: 'PRIVATE conflicting location' });
  rejection(response, 'internal_error', [id, 'PRIVATE', 'message_id_conflict']);
  assert.equal(f.bridge.outboundHistory()[0].reply, 'PRIVATE existing message');
});

test('callback challenge rejection keeps its existing reason and code', async t => {
  const f = await toolFixture(t);
  t.mock.method(f.sender, 'send', async () => ({ status: 200, body: '{"challenge":"wrong"}' }));
  const response = await rpc(f.bridge, { jsonrpc: '2.0', id: 7, method: 'events/subscribe', params: { ...f.subscription, name: 'utterance.created' } }) as any;
  assert.deepEqual(response.error, { code: -32015, message: 'CallbackEndpointError', data: { reason: 'challenge_failed' } });
});
