import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { bridgeServer } from '../server/http.ts';
import { toolFixture } from './tool-response-fixture.ts';

test('four tool reasons cross authenticated HTTP without leaking content or changing success', async t => {
  const f = await toolFixture(t);
  const tokens = { mcp: randomBytes(32).toString('hex'), device: randomBytes(32).toString('hex'), notification: randomBytes(32).toString('hex') };
  const server = bridgeServer(f.bridge, tokens, f.inbox, f.location);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const call = async (name: string, args?: unknown) => {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${tokens.mcp}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args, _meta: { progressToken: 9 } } }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const excluded = ['PRIVATE', tokens.mcp, tokens.device, tokens.notification, f.directory, f.utterance];
  const reason = async (name: string, args: unknown, expected: string) => {
    const value = await call(name, args);
    assert.equal(value.id, 9);
    assert.equal(value.error.code, expected === 'internal_error' ? -32603 : -32602);
    assert.deepEqual(value.error.data, { reason: expected });
    assert.equal(value.result, undefined);
    for (const secret of excluded) assert(!JSON.stringify(value).includes(secret));
  };
  for (const name of ['reply_to_g2', 'send_message_to_g2', 'announce_notification_to_g2', 'set_notification_disposition']) {
    await reason(name, undefined, 'invalid_arguments');
    await reason(name, { text: 'PRIVATE raw invalid input', extra: 'PRIVATE' }, 'invalid_arguments');
  }
  const unknown = randomUUID(); excluded.push(unknown);
  await reason('reply_to_g2', { utterance_id: unknown, text: 'PRIVATE reply' }, 'utterance_unknown');
  const reply = { utterance_id: f.utterance, text: 'PRIVATE reply' };
  const replied = await call('reply_to_g2', reply);
  assert.deepEqual(replied.result.structuredContent, { utterance_id: f.utterance, delivered_to_bridge: true });
  assert.deepEqual(await call('reply_to_g2', reply), replied);
  await reason('reply_to_g2', { ...reply, text: 'PRIVATE different reply' }, 'reply_conflict');

  const message = { message_id: randomUUID(), text: 'PRIVATE proactive message' }; excluded.push(message.message_id);
  const sent = await call('send_message_to_g2', message);
  assert.deepEqual(sent.result.structuredContent, { message_id: message.message_id, stored_for_g2: true, physical_display_confirmed: false });
  assert.deepEqual(await call('send_message_to_g2', message), sent);
  await reason('send_message_to_g2', { ...message, text: 'PRIVATE conflict' }, 'message_id_conflict');

  await reason('announce_notification_to_g2', { notification_id: unknown, text: 'PRIVATE announcement' }, 'notification_unknown');
  await reason('set_notification_disposition', { notification_id: unknown, disposition: 'silent' }, 'notification_unknown');
  const silent = await f.notification(); excluded.push(silent);
  const decision = { notification_id: silent, disposition: 'silent' };
  const decided = await call('set_notification_disposition', decision);
  assert.deepEqual(decided.result.structuredContent, { ...decision, stored_for_g2: false, wakeup_scheduled: false });
  assert.deepEqual(await call('set_notification_disposition', decision), decided);
  await reason('announce_notification_to_g2', { notification_id: silent, text: 'PRIVATE bypass' }, 'notification_silent');
  const id = await f.notification(); excluded.push(id);
  const announcement = { notification_id: id, text: 'PRIVATE announcement' };
  const announced = await call('announce_notification_to_g2', announcement);
  assert.deepEqual(announced.result.structuredContent, { notification_id: id, stored_for_g2: true });
  assert.deepEqual(await call('announce_notification_to_g2', announcement), announced);
  await reason('announce_notification_to_g2', { ...announcement, text: 'PRIVATE conflicting announcement' }, 'announcement_conflict');
  await reason('set_notification_disposition', { notification_id: id, disposition: 'later' }, 'notification_already_announced');

  for (const [path, name, args] of [
    [f.bridgePath, 'reply_to_g2', { utterance_id: (await f.bridge.submit({ id: randomUUID(), text: 'PRIVATE next utterance' })).id, text: 'PRIVATE reply' }],
    [f.bridgePath, 'send_message_to_g2', { message_id: randomUUID(), text: 'PRIVATE next message' }],
    [f.notificationPath, 'announce_notification_to_g2', { notification_id: await f.notification(), text: 'PRIVATE next announcement' }],
    [f.notificationPath, 'set_notification_disposition', { notification_id: await f.notification(), disposition: 'silent' }],
  ] as const) {
    mkdirSync(`${path}.tmp`);
    try { await reason(name, args, 'internal_error'); }
    finally { rmSync(`${path}.tmp`, { recursive: true }); }
    assert((await call(name, args)).result);
  }
});
