import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Bridge } from '../server/bridge.ts';
import { LocationContext } from '../server/location.ts';
import { SharingActivation } from '../server/sharing-activation.ts';
import { WebhookSender } from '../server/webhook.ts';
import { rpc } from '../server/http.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dot-sharing-'));
  const path = join(directory, 'activation.json');
  let now = Date.now(), authorized = true, response = 202;
  let receive: ((event: any) => Promise<void>) | undefined;
  const events: any[] = [];
  const hosts = ['callback.example.test'];
  const secret = 'whsec_' + randomBytes(32).toString('base64');
  const voice = {name: 'utterance.created', arguments: {session_id: 'personal-g2'},
    delivery: {mode: 'webhook', url: 'https://callback.example.test/voice', secret}};
  const location = {...voice, name: 'location.updated', delivery: {...voice.delivery, url: 'https://callback.example.test/location'}};
  const sender = new WebhookSender(async (_url, raw) => {
    const event = JSON.parse(raw);
    if (event.type === 'verification') return {status: 200, body: JSON.stringify({challenge: event.challenge})};
    events.push(event); await receive?.(event); return {status: response, body: '{}'};
  });
  const bridge = new Bridge(join(directory, 'bridge.json'), sender, hosts);
  const locations = new LocationContext(join(directory, 'location.json'), sender, hosts,
    (input, guard, context) => bridge.sendMessage(input, guard, context), () => now, () => authorized);
  const activations: SharingActivation[] = [];
  const activate = () => {const a = new SharingActivation(path, bridge, locations, () => now); activations.push(a); return a;};
  const id = randomUUID(), owner = 'a'.repeat(64);
  const enable = () => locations.control({sharing_id: id, enabled: true}, owner);
  const stop = () => locations.control({sharing_id: id, enabled: false}, owner);
  return {path, bridge, locations, voice, location, events, id, owner, enable, stop, activate,
    advance: (ms: number) => {now += ms;}, revoke: () => {authorized = false;},
    response: (status: number) => {response = status;}, receive: (fn: typeof receive) => {receive = fn;},
    close: () => {for (const a of activations) a.close(); bridge.close(); locations.close(); rmSync(directory, {recursive: true, force: true});}};
}

test('existing utterance-only connection: one sharing action requests actual location registration without fake conversation', async t => {
  const f = fixture(); t.after(f.close);
  await f.bridge.subscribe(f.voice);
  const a = f.activate();
  f.receive(async event => {
    if (event.name !== 'utterance.created') return;
    assert.match(event.data.text, /app control, not a spoken message/);
    const result: any = await rpc(f.bridge, {jsonrpc:'2.0', id:1, method:'tools/call',
      params:{name:'get_pending_utterances', arguments:{}}}, undefined, f.locations, undefined, undefined, a);
    assert.deepEqual(result.result.structuredContent.utterances, []);
    const request = result.result.structuredContent.control_requests[0];
    assert.equal(request.source, 'owner_sharing_control');
    assert.equal(request.event, 'location.updated');
    assert.equal(request.request_id, event.data.utterance_id);
    // The receiving platform supplies its own verified location callback, not a copied voice callback.
    const registered: any = await rpc(f.bridge, {jsonrpc:'2.0', id:2, method:'events/subscribe', params:f.location}, undefined, f.locations);
    assert.ok(registered.result.id);
  });
  f.enable(); await settle(); await settle();
  assert.equal(f.events.length, 1);
  assert.equal(f.locations.status().locationSubscribed, true);
  assert.equal(f.bridge.status().subscribed, true);
  assert.deepEqual(a.pending(), []);
  assert.deepEqual(f.bridge.history(), []);
  assert.deepEqual(f.bridge.outboundHistory(), []);
  await assert.rejects(f.bridge.reply({utterance_id:f.events[0].data.utterance_id, text:'Unwanted confirmation'}));
  f.receive(undefined);
  const utterance = randomUUID(); await f.bridge.submit({id:utterance, text:'Ordinary question'});
  await f.bridge.reply({utterance_id:utterance,text:'Ordinary answer'});
  assert.equal(f.bridge.history()[0].reply,'Ordinary answer');
  f.stop(); assert.equal(f.locations.read().context, null);
});

test('sharing before connection, duplicate controls, and restart do not require additional user input or duplicate delivery', async t => {
  const f = fixture(); t.after(f.close); const a = f.activate();
  f.enable(); await settle(); assert.equal(f.events.length, 0);
  await f.bridge.subscribe(f.voice); await settle();
  assert.equal(f.events.length, 1); assert.equal(f.locations.status().locationSubscribed, false);
  assert.equal(a.pending().length, 1); // webhook receipt alone is not actual activation
  f.enable(); await a.sync(); assert.equal(f.events.length, 1);
  a.close(); const resumed = f.activate(); await resumed.sync();
  assert.equal(f.events.length, 1); assert.equal(resumed.pending().length, 1);
  const stored = readFileSync(f.path, 'utf8');
  for (const value of [f.owner, f.id, f.voice.delivery.secret, f.voice.delivery.url]) assert.equal(stored.includes(value), false);
});

test('a prepared location subscription needs no activation request and consent still controls all context access', async t => {
  const f = fixture(); t.after(f.close);
  await f.bridge.subscribe(f.voice); await f.locations.subscribe(f.location);
  const a = f.activate(); f.enable(); await settle();
  assert.equal(f.events.length, 0); assert.deepEqual(a.pending(), []);
  f.stop(); assert.equal(f.locations.sharingIntent(), undefined);
  assert.equal(f.locations.status().locationSubscribed, true);
  assert.equal(f.locations.read().context, null);
});

test('stop, revocation, expiration and shutdown invalidate pending control requests', async t => {
  for (const mode of ['stop','revoke','expire','close'] as const) await t.test(mode, async t => {
    const f = fixture(); t.after(f.close); await f.bridge.subscribe(f.voice);
    const a = f.activate(); f.enable(); await settle(); assert.equal(a.pending().length, 1);
    if (mode === 'stop') f.stop();
    if (mode === 'revoke') f.revoke();
    if (mode === 'expire') f.advance(90_001);
    if (mode === 'close') a.close();
    assert.deepEqual(a.pending(), []); await a.sync(); assert.equal(f.events.length, 1);
  });
});

test('transient retries reuse event identity, survive restart and stop at three attempts', async t => {
  const f = fixture(); t.after(f.close); f.response(503); await f.bridge.subscribe(f.voice);
  const a = f.activate(); f.enable(); await settle(); assert.equal(f.events.length, 1);
  f.advance(5_001); await a.sync(); assert.equal(f.events.length, 2);
  a.close(); const resumed = f.activate(); f.advance(10_001); await resumed.sync();
  assert.equal(f.events.length, 3);
  f.advance(20_001); await resumed.sync(); assert.equal(f.events.length, 3);
  assert.equal(new Set(f.events.map(event => event.eventId)).size, 1);
  // Simulate a crash after the last pre-send persistence but before recording a response.
  resumed.close(); const record = JSON.parse(readFileSync(f.path, 'utf8'));
  writeFileSync(f.path, JSON.stringify({...record, delivery:'pending'}));
  const afterCrash = f.activate(); await afterCrash.sync(); assert.equal(f.events.length, 3);
});

test('revocation during delivery prevents delayed activation and no denied callback is invented', async t => {
  const f = fixture(); t.after(f.close); await f.bridge.subscribe(f.voice);
  const a = f.activate();
  f.receive(async () => {f.stop(); assert.deepEqual(a.pending(), []);});
  f.enable(); await settle(); await settle();
  assert.equal(f.events.length, 1); assert.equal(f.locations.status().locationSubscribed, false);
  assert.deepEqual(a.pending(), []);
});

test('an established subscription that later stops can be re-established without cycling sharing', async t => {
  const f = fixture(); t.after(f.close); await f.bridge.subscribe(f.voice);
  const a = f.activate(); f.enable(); await settle();
  await f.locations.subscribe(f.location); await settle();
  assert.equal(JSON.parse(readFileSync(f.path,'utf8')).delivery,'complete');
  await f.locations.unsubscribe({name:f.location.name, arguments:f.location.arguments,
    delivery:{mode:'webhook',url:f.location.delivery.url}});
  await settle(); assert.equal(f.events.length,2);
  assert.notEqual(f.events[0].eventId,f.events[1].eventId);
  assert.equal(a.pending().length,1);
});

test('permanent callback rejection does not loop or claim that Dot is ready', async t => {
  const f = fixture(); t.after(f.close); await f.bridge.subscribe(f.voice); f.response(413);
  const a = f.activate(); f.enable(); await settle();
  f.advance(30_000); await a.sync();
  assert.equal(f.events.length,1); assert.equal(f.locations.status().locationSubscribed,false);
  assert.equal(JSON.parse(readFileSync(f.path,'utf8')).delivery,'failed');
});
