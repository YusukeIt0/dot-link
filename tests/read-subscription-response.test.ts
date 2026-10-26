import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { rpc } from '../server/http.ts';
import { CallbackVerificationError } from '../server/webhook.ts';
import { toolFixture } from './tool-response-fixture.ts';

const privateValue = 'PRIVATE https://private.invalid/token /private/state.json';
function rejection(response: any, reason: string) {
  assert.equal(response.error?.code, reason === 'internal_error' ? -32603 : reason === 'challenge_failed' ? -32015 : -32602);
  assert.deepEqual(response.error.data, { reason });
  assert.equal(response.result, undefined);
  assert(!JSON.stringify(response).includes('PRIVATE'));
  assert(!JSON.stringify(response).includes('private.invalid'));
  assert(!JSON.stringify(response).includes('/private/'));
}

test('reads preserve omitted arguments and empty results, reject malformed arguments without disclosing them', async t => {
  const f = await toolFixture(t);
  for (const name of ['get_status', 'get_pending_utterances', 'get_pending_notifications', 'get_location_context']) {
    assert((await f.call(name)).result);
    assert((await f.call(name, {})).result);
    for (const args of [null, [], privateValue, { extra: privateValue }]) rejection(await f.call(name, args), 'invalid_arguments');
  }
  rejection(await f.call('get_pending_notifications', { include_deferred: privateValue }), 'invalid_arguments');
  assert.deepEqual((await f.call('get_pending_notifications', { include_deferred: true })).result.structuredContent.notifications, []);
  assert.equal((await f.call('get_location_context')).result.structuredContent.context, null);
  await f.bridge.reply({ utterance_id: f.utterance, text: 'Fixture reply' });
  assert.deepEqual((await f.call('get_pending_utterances')).result.structuredContent.utterances, []);
});

test('execution errors including internal validation errors are not caller argument errors', async t => {
  const f = await toolFixture(t);
  for (const [name, target, method] of [
    ['get_status', f.bridge, 'status'], ['get_pending_utterances', f.bridge, 'pendingResult'],
    ['get_pending_notifications', f.inbox, 'pending'], ['get_location_context', f.location, 'read'],
  ] as const) {
    const object = target as any;
    const original = object[method];
    for (const failure of [() => { throw new Error(privateValue); }, () => z.number().parse(privateValue)]) {
      object[method] = failure;
      rejection(await f.call(name), 'internal_error');
    }
    object[method] = original;
  }
  mkdirSync(`${f.bridgePath}.tmp`);
  rejection(await f.call('get_pending_utterances'), 'internal_error');
  rmSync(`${f.bridgePath}.tmp`, { recursive: true });
  assert((await f.call('get_pending_utterances')).result);
});

test('routing distinguishes malformed, unknown and unavailable operations before feature arguments', async t => {
  const f = await toolFixture(t);
  for (const method of ['tools/call', 'events/subscribe', 'events/unsubscribe']) {
    const call = (params: unknown) => rpc(f.bridge, { jsonrpc: '2.0', id: 7, method, params });
    for (const params of [undefined, null, [], {}, { name: 1 }, { name: '' }]) rejection(await call(params), 'invalid_arguments');
    rejection(await call({ name: privateValue }), method === 'tools/call' ? 'unknown_tool' : 'unknown_event');
    for (const name of method === 'tools/call'
      ? ['get_pending_notifications', 'announce_notification_to_g2', 'set_notification_disposition', 'get_location_context', 'respond_to_location']
      : ['notification.created', 'location.updated']) {
      rejection(await call({ name, arguments: null }), method === 'tools/call' ? 'tool_unavailable' : 'event_unavailable');
    }
  }
});

for (const name of ['utterance.created', 'notification.created', 'location.updated']) {
  test(`${name}: subscription reasons, renewal, no-op removal and challenge compatibility`, async t => {
    const f = await toolFixture(t);
    const call = (method: string, params: unknown) => rpc(f.bridge, { jsonrpc: '2.0', id: 7, method, params }, f.inbox, f.location) as Promise<any>;
    const params = { ...f.subscription, name, _meta: { progressToken: 1 } };
    const unsub = { name, arguments: params.arguments, delivery: { mode: 'webhook', url: params.delivery.url }, _meta: {} };
    const initial = await call('events/subscribe', params);
    assert(initial.result.id);
    assert.equal((await call('events/subscribe', { ...params, ttlMs: 10000 })).result.id, initial.result.id);
    for (const method of ['events/subscribe', 'events/unsubscribe']) {
      for (const patch of [{ arguments: null }, { delivery: null }, { arguments: { extra: privateValue } }]) {
        rejection(await call(method, { ...(method === 'events/subscribe' ? params : unsub), ...patch }), 'invalid_arguments');
      }
    }
    for (const url of ['PRIVATE bad URL', 'http://callback.example.test/events', 'https://private.invalid/PRIVATE']) {
      rejection(await call('events/subscribe', { ...params, delivery: { ...params.delivery, url } }), 'callback_destination_rejected');
    }
    rejection(await call('events/subscribe', { ...params, delivery: { ...params.delivery, secret: 'PRIVATE' } }), 'invalid_signing_secret');
    rejection(await call('events/subscribe', { ...params, delivery: { ...params.delivery, url: params.delivery.url + '/other' } }), 'subscription_conflict');
    assert.deepEqual((await call('events/unsubscribe', { ...unsub, delivery: { ...unsub.delivery, url: params.delivery.url + '/other' } })).result, {});
    const verify = f.sender.verify;
    f.sender.verify = async () => { throw new CallbackVerificationError(); };
    const failed = await call('events/subscribe', params);
    rejection(failed, 'challenge_failed');
    assert.equal(failed.error.message, 'CallbackEndpointError');
    f.sender.verify = async () => { throw new Error(privateValue); };
    rejection(await call('events/subscribe', params), 'internal_error');
    f.sender.verify = verify;
    assert.equal((await call('events/subscribe', params)).result.id, initial.result.id);
    assert.deepEqual((await call('events/unsubscribe', unsub)).result, {});
    assert.deepEqual((await call('events/unsubscribe', unsub)).result, {});
  });

  for (const failure of ['write', 'rename']) test(`${name}: failed ${failure} preserves subscription state and identical retry`, async t => {
    const f = await toolFixture(t);
    const path = name === 'utterance.created' ? f.bridgePath : name === 'notification.created' ? f.notificationPath : join(f.directory, 'location.json');
    const feature = name === 'utterance.created' ? f.bridge : name === 'notification.created' ? f.inbox : f.location;
    const subscribed = () => {
      const status = feature.status() as any;
      return status.subscribed ?? status.notificationSubscribed ?? status.locationSubscribed;
    };
    const params = { ...f.subscription, name };
    const unsub = { name, arguments: params.arguments, delivery: { mode: 'webhook', url: params.delivery.url } };
    const call = (method: string, input: unknown) => rpc(f.bridge, { jsonrpc: '2.0', id: 7, method, params: input }, f.inbox, f.location) as Promise<any>;
    const block = () => { if (failure === 'write') mkdirSync(path + '.tmp'); else { renameSync(path, path + '.backup'); mkdirSync(path); } };
    const restore = () => { if (failure === 'write') rmSync(path + '.tmp', { recursive: true }); else { rmSync(path, { recursive: true }); renameSync(path + '.backup', path); } };
    await call('events/unsubscribe', unsub);
    assert.equal(subscribed(), false);
    const before = readFileSync(path, 'utf8');
    block(); rejection(await call('events/subscribe', params), 'internal_error');
    assert.equal(subscribed(), false);
    restore(); assert.equal(readFileSync(path, 'utf8'), before);
    assert((await call('events/subscribe', params)).result);
    assert.equal(subscribed(), true);
    const saved = readFileSync(path, 'utf8');
    block(); rejection(await call('events/subscribe', { ...params, ttlMs: 12345 }), 'internal_error');
    assert.equal(subscribed(), true);
    restore(); assert.equal(readFileSync(path, 'utf8'), saved);
    block(); rejection(await call('events/unsubscribe', unsub), 'internal_error');
    assert.equal(subscribed(), true);
    restore(); assert.equal(readFileSync(path, 'utf8'), saved);
    assert.deepEqual((await call('events/unsubscribe', unsub)).result, {});
    assert.equal(subscribed(), false);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).subscription, undefined);
  });
}

test('rejected destinations retain sanitized operator diagnostics without exposing URL paths or secrets', async t => {
  const f = await toolFixture(t);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = value => warnings.push(String(value));
  try {
    const params = { ...f.subscription, name: 'utterance.created', delivery: { ...f.subscription.delivery, url: 'https://rejected.example.test/PRIVATE?secret=PRIVATE' } };
    const response = await rpc(f.bridge, { jsonrpc: '2.0', id: 7, method: 'events/subscribe', params });
    rejection(response, 'callback_destination_rejected');
    assert(!JSON.stringify(response).includes('rejected.example.test'));
    assert.deepEqual(warnings.map(value => JSON.parse(value)), [{ event: 'callback_host_rejected', hostname: 'rejected.example.test' }]);
    assert(!warnings.join('').includes('PRIVATE'));
    assert(!warnings.join('').includes(f.subscription.delivery.secret));
  } finally { console.warn = original; }
});
