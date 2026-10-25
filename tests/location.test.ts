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
  let ownerAllowed = true;
  let beforeAnnouncement: (() => Promise<void>) | undefined;
  const events: any[] = [];
  const sender = new WebhookSender(async (_url, raw) => {
    const e = JSON.parse(raw);
    if (e.type === 'verification') return {status: 200, body: JSON.stringify({challenge: e.challenge})};
    events.push(e); return {status: 202, body: '{}'};
  });
  const bridge = new Bridge(join(directory, 'bridge.json'), sender, ['callback.example.test']);
  const path = join(directory, 'location.json');
  const create = () => new LocationContext(path, sender, ['callback.example.test'], async (input, guard, location) => {
    await beforeAnnouncement?.();
    return bridge.sendMessage(input, guard, location);
  }, () => time, () => ownerAllowed);
  const context = create();
  t.after(() => {context.close(); rmSync(directory, {recursive: true, force: true});});
  const sharing = randomUUID();
  let sequence = 0;
  const fix = (latitude = 10, accuracy = 5) => ({latitude, longitude: 20, accuracy, measured_at: new Date(time).toISOString()});
  const update = (latitude = 10, accuracy = 5) => context.update({sharing_id: sharing, sequence: ++sequence, fix: fix(latitude, accuracy)}, owner);
  const enable = () => context.control({sharing_id: sharing, enabled: true}, owner);
  const disable = () => context.control({sharing_id: sharing, enabled: false}, owner);
  return {context, create, bridge, path, events, fix, update, enable, disable, sharing, advance: (ms: number) => {time += ms;},
    revokeOwner: () => {ownerAllowed = false;}, beforeAnnouncement: (hook: () => Promise<void>) => {beforeAnnouncement = hook;}};
}

const respond = (f: ReturnType<typeof fixture>, args: unknown) => rpc(f.bridge,
  {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'respond_to_location', arguments: args}}, undefined, f.context) as Promise<any>;
function rejection(result: any, reason: string) {
  assert.equal(result.error?.code, reason === 'internal_error' ? -32603 : -32602);
  assert.deepEqual(result.error.data, {reason});
  assert.equal(result.result, undefined);
  assert.doesNotMatch(result.error.message, /subscription|callback/);
}

test('location response argument errors expose fixed reasons, never submitted values', async t => {
  const f = fixture(t); f.enable(); f.update();
  const context_id = f.context.read().context!.context_id;
  const secret = 'PRIVATE-CONTENT-https://callback.invalid/secret';
  const cases: [unknown, string][] = [
    [undefined, 'invalid_arguments'], [null, 'invalid_arguments'],
    [{context_id: secret, disposition: 'silent'}, 'invalid_arguments'],
    [{context_id, disposition: secret}, 'invalid_arguments'],
    [{context_id, disposition: 'silent', extra: secret}, 'invalid_arguments'],
    ...['', ' ', null, 5].map(text => [{context_id, disposition: 'silent', text}, 'invalid_arguments'] as [unknown, string]),
    [{context_id, disposition: 'silent', text: secret}, 'text_not_allowed_for_silent'],
    [{context_id, disposition: 'announce'}, 'text_required_for_announcement'],
    [{context_id, disposition: 'announce', text: ''}, 'invalid_arguments'],
    [{context_id, disposition: 'announce', text: 'x'.repeat(2001)}, 'invalid_arguments'],
  ];
  for (const [args, reason] of cases) {
    const result = await respond(f, args); rejection(result, reason);
    assert(!JSON.stringify(result).includes(secret));
    assert(!JSON.stringify(result).includes(context_id));
  }
  assert.equal(f.context.status().locationDecisionAt, null);
  assert.equal(f.bridge.outboundHistory().length, 0);
  assert.equal(f.context.status().locationSubscribed, false);
  const success = await respond(f, {context_id, disposition: 'silent'});
  assert.deepEqual(success.result.structuredContent, {stored_for_g2: false});
  assert.deepEqual(await respond(f, {context_id, disposition: 'silent'}), success);
});

test('location reasons distinguish unknown context, stopped sharing, expired lease and revoked pairing', async t => {
  for (const change of ['unknown', 'off', 'lease', 'pairing'] as const) {
    const f = fixture(t); f.enable(); f.update();
    const id = f.context.read().context!.context_id;
    if (change === 'off') f.disable();
    if (change === 'lease') f.advance(90_001);
    if (change === 'pairing') f.revokeOwner();
    rejection(await respond(f, {context_id: change === 'unknown' ? randomUUID() : id, disposition: 'silent'}),
      change === 'unknown' ? 'context_unknown' : 'sharing_inactive');
    assert.equal(f.context.status().locationDecisionAt, null);
    assert.equal(f.bridge.outboundHistory().length, 0);
  }
});

test('a fresh latest fix does not hide an expired read context, including the 90-second boundary', async t => {
  const f = fixture(t); f.enable(); f.update();
  const id = f.context.read().context!.context_id;
  f.advance(89_000); f.update();
  f.advance(1000);
  const atBoundary = await respond(f, {context_id: id, disposition: 'silent'});
  assert.deepEqual(atBoundary.result.structuredContent, {stored_for_g2: false});
  // Another context can expire while the current measurement and lease stay fresh.
  const next = f.context.read().context!.context_id;
  f.advance(90_001); f.update();
  assert.equal(f.context.status().locationFresh, true);
  rejection(await respond(f, {context_id: next, disposition: 'silent'}), 'context_expired');
  // Accepted identical retries remain idempotent even after the original fix expires.
  assert.deepEqual(await respond(f, {context_id: id, disposition: 'silent'}), atBoundary);
  assert.deepEqual((await respond(f, {context_id: f.context.read().context!.context_id, disposition: 'silent'})).result.structuredContent,
    {stored_for_g2: false});
});

test('a stale latest fix with an active sharing lease returns context_expired', async t => {
  const f = fixture(t); f.enable(); f.update();
  const id = f.context.read().context!.context_id;
  f.advance(90_001); f.context.update({sharing_id: f.sharing, sequence: 2}, owner);
  assert.equal(f.context.status().locationSharing, true);
  rejection(await respond(f, {context_id: id, disposition: 'silent'}), 'context_expired');
});

test('successive noisy fixes reject with moved_too_far and permit a fresh stable silent decision', async t => {
  const f = fixture(t); f.enable(); f.update(10, 100);
  let id = f.context.read().context!.context_id;
  f.advance(7000); f.update(10.0011, 100);
  rejection(await respond(f, {context_id: id, disposition: 'silent'}), 'moved_too_far');
  id = f.context.read().context!.context_id;
  f.advance(7000); f.update(10, 100);
  rejection(await respond(f, {context_id: id, disposition: 'silent'}), 'moved_too_far');
  assert.equal(f.context.status().locationDecisionAt, null);
  id = f.context.read().context!.context_id;
  f.advance(15_000); f.update(10.0001, 100);
  assert.deepEqual((await respond(f, {context_id: id, disposition: 'silent'})).result.structuredContent, {stored_for_g2: false});
  assert.equal(f.bridge.outboundHistory().length, 0);
});

test('conflicting decisions return a reason and never overwrite the original announcement', async t => {
  const f = fixture(t); f.enable(); f.update();
  const context_id = f.context.read().context!.context_id;
  const first = await respond(f, {context_id, disposition: 'announce', text: 'Original synthetic announcement'});
  assert.equal(first.result.structuredContent.stored_for_g2, true);
  for (const args of [{context_id, disposition: 'silent'}, {context_id, disposition: 'announce', text: 'Changed'}]) {
    rejection(await respond(f, args), 'conflicting_decision');
  }
  assert.equal(f.bridge.outboundHistory().length, 1);
  assert.equal(f.bridge.outboundHistory()[0].reply, 'Original synthetic announcement');
});

test('announcement revalidation reports the reason when context changes before storage', async t => {
  for (const change of ['off', 'move', 'expire', 'replace'] as const) {
    const f = fixture(t); f.enable(); f.update();
    const id = f.context.read().context!.context_id;
    f.beforeAnnouncement(async () => {
      if (change === 'off') f.disable();
      if (change === 'move') f.update(10.01);
      if (change === 'expire') { f.advance(90_001); f.update(); }
      if (change === 'replace') {
        const sharing_id = randomUUID(); f.context.control({sharing_id, enabled: true}, owner);
        f.context.update({sharing_id, sequence: 1, fix: f.fix()}, owner);
      }
    });
    rejection(await respond(f, {context_id: id, disposition: 'announce', text: 'Must not be stored'}),
      {off: 'sharing_inactive', move: 'moved_too_far', expire: 'context_expired', replace: 'context_unknown'}[change]);
    assert.equal(f.bridge.outboundHistory().length, 0);
    assert.equal(f.context.status().locationDecisionAt, null);
  }
});

test('unexpected location failures return a fixed internal_error without leaking error details', async t => {
  const f = fixture(t); f.enable(); f.update();
  const secret = 'PRIVATE-ERROR-https://callback.invalid/secret';
  f.beforeAnnouncement(async () => {throw new Error(secret);});
  const result = await respond(f, {context_id: f.context.read().context!.context_id, disposition: 'announce', text: secret});
  rejection(result, 'internal_error');
  assert(!JSON.stringify(result).includes(secret));
  assert.equal(f.bridge.outboundHistory().length, 0);
  assert.equal(f.context.status().locationDecisionAt, null);
  // An unsuccessful announcement must not poison later silent decisions.
  assert.deepEqual((await respond(f, {context_id: f.context.read().context!.context_id, disposition: 'silent'})).result.structuredContent,
    {stored_for_g2: false});
});

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
