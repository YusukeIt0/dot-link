import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocationContext } from '../server/location.ts';
import { WebhookSender } from '../server/webhook.ts';
import { Bridge } from '../server/bridge.ts';
import { rpc } from '../server/http.ts';
import { phoneLocation } from '../src/location-fix.ts';

const owner = 'a'.repeat(64);
const request = {name: 'location.updated', arguments: {session_id: 'personal-g2'}, delivery: {mode: 'webhook', url: 'https://callback.example.test/location', secret: 'whsec_' + randomBytes(32).toString('base64')}};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: {after: (fn: () => void) => void}) {
  const directory = mkdtempSync(join(tmpdir(), 'dot-location-'));
  let time = Date.now();
  const events: any[] = [];
  const sender = new WebhookSender(async (_url, raw) => {
    const e = JSON.parse(raw);
    if (e.type === 'verification') return {status: 200, body: JSON.stringify({challenge: e.challenge})};
    events.push(e); return {status: 202, body: '{}'};
  });
  const bridge = new Bridge(join(directory, 'bridge.json'), sender, ['callback.example.test']);
  const path = join(directory, 'location.json');
  const create = () => new LocationContext(path, sender, ['callback.example.test'], (input, guard) => bridge.sendMessage(input, guard), () => time);
  const context = create();
  t.after(() => {context.close(); rmSync(directory, {recursive: true, force: true});});
  const sharing = randomUUID();
  let sequence = 0;
  const fix = (latitude = 10, accuracy = 5) => ({latitude, longitude: 20, accuracy, measured_at: new Date(time).toISOString()});
  const update = (latitude = 10, accuracy = 5) => context.update({sharing_id: sharing, sequence: ++sequence, fix: fix(latitude, accuracy)}, owner);
  const enable = () => context.control({sharing_id: sharing, enabled: true}, owner);
  const disable = () => context.control({sharing_id: sharing, enabled: false}, owner);
  return {context, create, bridge, path, events, fix, update, enable, disable, sharing, advance: (ms: number) => {time += ms;}};
}

test('location consent, subscription and current data stay separate from voice and persisted coordinates', async t => {
  const f = fixture(t);
  assert.throws(() => f.update());
  await f.bridge.subscribe({...request, name: 'utterance.created'});
  await f.context.subscribe(request);
  assert.equal(f.context.read().context, null);
  f.enable(); f.update(); await flush();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].name, 'location.updated');
  assert.deepEqual(Object.keys(f.events[0].data).sort(), ['session_id', 'update_id']);
  assert.deepEqual(f.bridge.pending().utterances, []);
  const read = f.context.read();
  assert.equal(read.context?.latitude, 10);
  assert.equal(read.context?.source, 'phone_location');
  const disk = readFileSync(f.path, 'utf8');
  for (const forbidden of ['latitude', 'longitude', 'measured_at', 'accuracy']) assert.equal(disk.includes(forbidden), false);
  const restored = f.create(); t.after(() => restored.close());
  assert.equal(restored.status().locationSubscribed, true);
  assert.equal(restored.read().context, null);
  assert.equal(f.bridge.status().subscribed, true);
});

test('Dot can remain silent, then independently announce on new movement without synthetic utterances', async t => {
  const f = fixture(t); await f.context.subscribe(request); f.enable(); f.update(); await flush();
  const first = f.context.read().context!;
  await f.context.respond({context_id: first.context_id, disposition: 'silent'});
  assert.equal(f.bridge.outboundHistory().length, 0);
  f.advance(31_000); f.update(10.001); await flush();
  assert.equal(f.events.length, 2);
  const current = f.context.read().context!;
  const decision = {context_id: current.context_id, disposition: 'announce', text: 'Synthetic location test message'};
  await Promise.all([f.context.respond(decision), f.context.respond(decision)]);
  assert.equal(f.bridge.outboundHistory().length, 1);
  assert.deepEqual(f.bridge.pending().utterances, []);
  await assert.rejects(f.context.respond({...decision, text: 'Different'}));
  assert.deepEqual(f.context.read().recent_announcements, [decision.text]);
});

test('OFF removes coordinates, rejects delayed enable and upload, and prevents a queued announcement', async t => {
  const f = fixture(t); f.enable(); f.update();
  const id = f.context.read().context!.context_id;
  const pending = f.context.respond({context_id: id, disposition: 'announce', text: 'Must not be delivered'});
  f.disable();
  await assert.rejects(pending);
  assert.equal(f.context.read().context, null);
  assert.equal(f.bridge.outboundHistory().length, 0);
  assert.throws(f.update);
  assert.throws(f.enable);
  const restored = f.create(); t.after(() => restored.close());
  assert.throws(() => restored.control({sharing_id: f.sharing, enabled: true}, owner));
});

test('lease and measurement expiry independently prevent stale recommendations', async t => {
  const f = fixture(t); f.enable(); f.update();
  const id = f.context.read().context!.context_id;
  f.advance(91_000);
  assert.equal(f.context.status().locationSharing, false);
  assert.equal(f.context.read().context, null);
  await assert.rejects(f.context.respond({context_id: id, disposition: 'announce', text: 'Too late'}));
  f.context.update({sharing_id: f.sharing, sequence: 2}, owner); // Heartbeat renews sharing, not measurement freshness.
  assert.equal(f.context.status().locationSharing, true);
  assert.equal(f.context.read().context, null);
  f.context.update({sharing_id: f.sharing, sequence: 3, fix: f.fix()}, owner);
  assert.ok(f.context.read().context);
});

test('out-of-order fixes and another device cannot replace current position or consent', t => {
  const f = fixture(t); f.enable(); f.update();
  f.context.update({sharing_id: f.sharing, sequence: 0, fix: f.fix(15)}, owner);
  assert.equal(f.context.read().context?.latitude, 10);
  assert.throws(() => f.context.update({sharing_id: f.sharing, sequence: 2, fix: f.fix(15)}, 'b'.repeat(64)));
  assert.throws(() => f.context.control({sharing_id: randomUUID(), enabled: true}, 'b'.repeat(64)));
  assert.throws(() => f.context.control({sharing_id: f.sharing, enabled: false}, 'b'.repeat(64)));
  assert.throws(() => f.context.update({sharing_id: f.sharing, sequence: 2, fix: {...f.fix(), latitude: 100}}, owner));
  assert.throws(() => f.context.update({sharing_id: f.sharing, sequence: 2, fix: {...f.fix(), accuracy: 999}}, owner));
});

test('a delayed old WebView cannot take over a newly restored sharing session', t => {
  const f = fixture(t); f.enable(); f.update();
  const newer = randomUUID();
  f.context.control({sharing_id: newer, enabled: true}, owner);
  assert.throws(f.enable);
  assert.throws(f.update);
  f.context.update({sharing_id: newer, sequence: 1, fix: f.fix()}, owner);
  assert.equal(f.context.read().context?.latitude, 10);
});

test('position noise does not create new Dot tasks; in-flight movement coalesces to the latest position', async t => {
  const f = fixture(t); await f.context.subscribe(request); f.enable(); f.update(); await flush();
  const first = f.context.read().context!;
  for (let i = 0; i < 4; i++) { f.advance(15_000); f.update(10 + 0.00001 * i); }
  await flush(); assert.equal(f.events.length, 1);
  await f.context.respond({context_id: first.context_id, disposition: 'silent'});
  f.advance(15_000); f.update(10.00002); await flush(); assert.equal(f.events.length, 1);
  f.advance(15_000); f.update(10.002); await flush(); assert.equal(f.events.length, 2);
  const previous = f.context.read().context!;
  f.advance(15_000); f.update(10.005);
  await assert.rejects(f.context.respond({context_id: previous.context_id, disposition: 'announce', text: 'Already passed'}));
  assert.equal(f.context.read().context?.latitude, 10.005);
});

test('new location tools and event are exposed through RPC without replacing existing ones', async t => {
  const f = fixture(t);
  const call = (method: string, params?: unknown) => rpc(f.bridge, {jsonrpc: '2.0', id: 1, method, params}, undefined, f.context) as Promise<any>;
  const tools = (await call('tools/list')).result.tools.map((tool: any) => tool.name);
  assert(tools.includes('get_pending_utterances')); assert(tools.includes('get_location_context')); assert(tools.includes('respond_to_location'));
  const events = (await call('events/list')).result.events.map((event: any) => event.name);
  assert.deepEqual(events, ['utterance.created', 'location.updated']);
  await call('events/subscribe', request); f.enable(); f.update(); await flush();
  const result = await call('tools/call', {name: 'get_location_context', arguments: {}, _meta: {}});
  assert.equal(result.result.structuredContent.context.latitude, 10);
  await call('events/unsubscribe', {...request, delivery: {mode: 'webhook', url: request.delivery.url}});
  assert.equal(f.context.status().locationSubscribed, false);
});

test('SDK coordinates with missing time, missing precision, stale time or invalid ranges are not labeled current', () => {
  const now = Date.now(), base = {latitude: 10, longitude: 20, accuracy: 5, timestamp: now};
  assert.ok(phoneLocation(base, now));
  for (const change of [{timestamp: undefined}, {accuracy: undefined}, {timestamp: now - 100_000}, {timestamp: now + 60_000}, {latitude: 91}, {longitude: NaN}, {accuracy: 1000}]) assert.equal(phoneLocation({...base, ...change}, now), undefined);
});
