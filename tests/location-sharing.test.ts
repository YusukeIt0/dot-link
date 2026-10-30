import test from 'node:test';
import assert from 'node:assert/strict';
import { LocationSharing } from '../src/location-sharing.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocationContext } from '../server/location.ts';
import { WebhookSender } from '../server/webhook.ts';
import type { AppLocation } from '@evenrealities/even_hub_sdk';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
function fixture(relay?: (path: string, body: unknown) => unknown) {
  let now = Date.now();
  let target: string | undefined = 'https://relay.example.test';
  const local = new Map<string, string>(), nativeStore = new Map<string, string>();
  const requests: {path: string; body: any}[] = [];
  let listener: ((fix: AppLocation) => void) | undefined;
  let starts = 0, stops = 0, reads = 0, failed = false;
  const fix = (): AppLocation => ({latitude: 10, longitude: 20, accuracy: 5, timestamp: now});
  const native = {
    getLocalStorage: async (key: string) => nativeStore.get(key) ?? '',
    setLocalStorage: async (key: string, raw: string) => {nativeStore.set(key, raw); return true;},
    onAppLocationChanged: (callback: (fix: AppLocation) => void) => {listener = callback; return () => {listener = undefined;};},
    startAppLocationUpdates: async () => {starts++; return true;},
    stopAppLocationUpdates: async () => {stops++; return true;},
    getAppLocation: async (): Promise<AppLocation | null> => {reads++; return fix();},
  };
  const controller = new LocationSharing({automatic: false, now: () => now, storage: () => ({getItem: key => local.get(key) ?? null, setItem: (key, raw) => {local.set(key, raw);}}),
    target: () => target, changed: () => {}, api: async (path, body) => {
      requests.push({path, body}); if (failed) throw new Error('Offline');
      if (relay) return relay(path, body);
      const p = body as any;
      return path.endsWith('/control') ? {enabled: p.enabled} : {locationSharing: true, locationSubscribed: true, locationFresh: !!p.fix, locationMeasuredAt: p.fix?.measured_at, locationAccuracy: p.fix?.accuracy, locationReceivedAt: new Date(now).toISOString()};
    }});
  return {controller, native, local, nativeStore, requests, fix, emit: () => listener?.(fix()), starts: () => starts, stops: () => stops, reads: () => reads,
    now: () => now, advance: (ms: number) => {now += ms;}, setTarget: (value?: string) => {target = value;}, fail: (value: boolean) => {failed = value;}};
}

test('no permission request, position acquisition or upload happens before explicit ON', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  await f.controller.attach(f.native); await f.controller.pump();
  assert.equal(f.starts(), 0); assert.equal(f.reads(), 0); assert.equal(f.requests.length, 0);
  f.emit(); await f.controller.pump(); assert.equal(f.requests.length, 0);
  f.controller.setEnabled(true); await flush();
  assert.equal(f.starts(), 1); assert.equal(f.controller.status().state, 'sharing');
  assert.deepEqual(f.requests.map(r => r.path), ['/api/location/control', '/api/location/update']);
  assert.equal(f.requests[1].body.fix.latitude, 10);
  for (const saved of [...f.local.values(), ...f.nativeStore.values()]) {
    assert.equal(saved.includes('latitude'), false); assert.equal(saved.includes('measured_at'), false);
  }
});

test('OFF stops the native source, revokes the relay, and ignores later native callbacks', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.attach(f.native);
  f.controller.setEnabled(true); await flush();
  f.controller.setEnabled(false); await flush();
  assert.equal(f.stops(), 1); assert.equal(f.controller.status().state, 'off');
  assert.equal(f.requests.at(-1)?.body.enabled, false);
  const count = f.requests.length;
  f.emit(); await f.controller.pump(); assert.equal(f.requests.length, count);
});

test('OFF during a one-shot location request reaches the relay before the measurement resolves', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  await f.controller.attach(f.native); f.controller.setEnabled(true); await flush();
  f.advance(31_000);
  let resolveFix!: (fix: AppLocation) => void;
  f.native.getAppLocation = () => new Promise(resolve => {resolveFix = resolve;});
  const pumping = f.controller.pump(); await flush();
  assert.equal(typeof resolveFix, 'function');
  f.controller.setEnabled(false); await flush();
  assert.equal(f.requests.at(-1)?.body.enabled, false);
  resolveFix(f.fix()); await pumping; await flush();
  assert.equal(f.requests.filter(r => r.path.endsWith('/update')).length, 1);
});

test('failed native stop stays visibly pending and retries without uploading more locations', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  await f.controller.attach(f.native); f.controller.setEnabled(true); await flush();
  let attempts = 0;
  f.native.stopAppLocationUpdates = async () => ++attempts > 2;
  f.controller.setEnabled(false); await flush();
  assert.equal(f.controller.status().state, 'stopping');
  const updates = f.requests.filter(r => r.path.endsWith('/update')).length;
  f.emit(); await f.controller.pump(); await flush();
  assert.equal(f.controller.status().state, 'off');
  assert.equal(f.requests.filter(r => r.path.endsWith('/update')).length, updates);
});

test('offline OFF remains pending and is delivered before a new sharing session', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.attach(f.native);
  f.controller.setEnabled(true); await flush(); const first = f.requests[0].body.sharing_id;
  f.fail(true); f.controller.setEnabled(false); await flush();
  assert.equal(f.controller.status().state, 'stopping');
  f.controller.setEnabled(true); await flush();
  f.fail(false); await f.controller.pump();
  const successfulOrder = f.requests.slice(-3);
  assert.equal(successfulOrder[0].body.sharing_id, first); assert.equal(successfulOrder[0].body.enabled, false);
  assert.equal(successfulOrder[1].body.enabled, true); assert.notEqual(successfulOrder[1].body.sharing_id, first);
  assert.equal(successfulOrder[2].path, '/api/location/update');
});

test('native saved consent restores only for the same relay; late restore cannot override an OFF click', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  let resolveStore!: (raw: string) => void;
  f.native.getLocalStorage = () => new Promise(resolve => {resolveStore = resolve;});
  const attaching = f.controller.attach(f.native);
  f.controller.setEnabled(false);
  resolveStore(JSON.stringify({enabled: true, origin: 'https://relay.example.test', stops: []}));
  await attaching; assert.equal(f.controller.status().enabled, false); assert.equal(f.starts(), 0);
  const g = fixture(); t.after(() => g.controller.stop());
  g.nativeStore.set('dot-location-sharing-v1', JSON.stringify({enabled: true, origin: 'https://different.example.test', stops: []}));
  await g.controller.attach(g.native); assert.equal(g.controller.status().enabled, false); assert.equal(g.starts(), 0); assert.deepEqual(g.requests, []);
});

test('failed native permission does not repeatedly prompt; toggling allows a deliberate retry', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  let attempts = 0; f.native.startAppLocationUpdates = async () => {attempts++; return false;};
  await f.controller.attach(f.native); f.controller.setEnabled(true); await flush();
  assert.equal(f.controller.status().state, 'unavailable');
  await f.controller.pump(); await f.controller.pump(); assert.equal(attempts, 1);
  assert.equal(f.requests.length, 0);
  f.controller.setEnabled(false); await flush(); f.controller.setEnabled(true); await flush(); assert.equal(attempts, 2);
});

test('stale measurements are not uploaded as fresh, and explicit exit retains preference but stops source', async t => {
  const f = fixture(); await f.controller.attach(f.native); f.controller.setEnabled(true); await flush();
  const count = f.requests.length;
  f.advance(100_000); f.native.getAppLocation = async () => null;
  await f.controller.pump();
  assert.equal(f.requests.length, count); assert.equal(f.controller.status().state, 'stale');
  await f.controller.stop(); await flush(); assert.equal(f.stops(), 1);
  assert.equal(JSON.parse(f.nativeStore.get('dot-location-sharing-v1')!).enabled, true);
  assert.equal(f.requests.at(-1)?.body.enabled, false);
});

test('a late G2 announcement is suppressed after OFF, expiry or a previous sharing session', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.attach(f.native);
  f.controller.setEnabled(true); await flush();
  const message = {location_sharing_id: f.requests[0].body.sharing_id, location_expires_at: new Date(Date.now() + 90_000).toISOString()};
  assert.equal(f.controller.acceptsAnnouncement(message), true);
  assert.equal(f.controller.acceptsAnnouncement({}), true);
  f.controller.setEnabled(false); await flush(); assert.equal(f.controller.acceptsAnnouncement(message), false);
  f.controller.setEnabled(true); await flush(); assert.equal(f.controller.acceptsAnnouncement(message), false);
  const latest = {...message, location_sharing_id: f.requests.at(-1)?.body.sharing_id};
  assert.equal(f.controller.acceptsAnnouncement(latest), true);
  f.advance(100_000); assert.equal(f.controller.acceptsAnnouncement(latest), false);
});


test('missing exit event cannot renew sharing with cached fixes or empty heartbeats', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  const cached = f.fix();
  f.native.getAppLocation = async () => cached;
  await f.controller.attach(f.native); f.controller.setEnabled(true); await flush();
  const count = f.requests.length;
  assert.equal(count, 2);
  // The native source stops but JavaScript remains alive, with no exit callback.
  for (let i = 0; i < 20; i++) {
    f.advance(15_000);
    if (i >= 6) f.controller.receive({locationSharing: false, locationFresh: false});
    await f.controller.pump();
  }
  assert.equal(f.requests.length, count, 'neither control nor update may renew the lease');
  assert.equal(f.controller.status().enabled, true, 'saved consent remains available for recovery');
  assert.equal(f.controller.status().state, 'stale');
  f.emit(); await f.controller.pump();
  assert.equal(f.requests.length, count + 2, 'a new measurement re-enables and updates the expired lease');
  assert.equal(f.requests.at(-1)?.body.fix.measured_at, new Date(cached.timestamp! + 300_000).toISOString());
});

test('no first measurement means no live sharing lease, and a later fix starts sharing', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  f.native.getAppLocation = async () => null;
  await f.controller.attach(f.native); f.controller.setEnabled(true); await flush();
  for (let i = 0; i < 10; i++) { f.advance(15_000); await f.controller.pump(); }
  assert.equal(f.requests.length, 0);
  assert.equal(f.controller.status().state, 'waiting');
  f.emit(); await f.controller.pump();
  assert.deepEqual(f.requests.map(r => r.path), ['/api/location/control', '/api/location/update']);
});


test('real relay lease expires while an exited native source leaves the WebView timer running', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-exit-lease-'));
  let context!: LocationContext;
  const f = fixture((path, body) => path.endsWith('/control') ? context.control(body, 'owner') : context.update(body, 'owner'));
  context = new LocationContext(join(directory, 'location.json'), new WebhookSender(async () => ({status: 200, body: '{}'})), [], async () => ({}), f.now);
  t.after(async () => { await f.controller.stop(); context.close(); rmSync(directory, {recursive: true, force: true}); });
  const cached = f.fix(); f.native.getAppLocation = async () => cached;
  await f.controller.attach(f.native); f.controller.setEnabled(true); await flush();
  assert.equal(context.status().locationSharing, true);
  // A live timer and repeated cached measurements must not extend the last upload's lease.
  for (let i = 0; i < 20; i++) {
    f.advance(15_000); f.controller.receive(context.status()); await f.controller.pump();
    if (i >= 6) assert.equal(context.status().locationSharing, false);
  }
  assert.equal(context.read().context, null);
  f.emit(); await f.controller.pump();
  assert.equal(context.status().locationSharing, true);
  assert.equal(context.status().locationFresh, true);
});

test('handoff abandons location without changing consent, stopping native acquisition or sending revocation', async () => {
  const f = fixture(); await f.controller.attach(f.native);
  f.controller.setEnabled(true); await flush();
  const local = [...f.local], native = [...f.nativeStore], requests = f.requests.length;
  f.controller.abandon(); f.emit(); await f.controller.pump(); await f.controller.stop(); await flush();
  assert.equal(f.stops(), 0); assert.equal(f.requests.length, requests);
  assert.deepEqual([...f.local], local); assert.deepEqual([...f.nativeStore], native);
});
test('handoff during a native location start cannot send a late stop or preference write', async () => {
  const f = fixture(); await f.controller.attach(f.native);
  let release!: (ok: boolean) => void;
  f.native.startAppLocationUpdates = () => new Promise(resolve => {release = resolve;});
  f.controller.setEnabled(true); await flush();
  const saved = [...f.nativeStore];
  f.controller.abandon(); release(true); await flush();
  assert.equal(f.stops(), 0); assert.equal(f.requests.length, 0);
  assert.deepEqual([...f.nativeStore], saved);
  assert.equal(f.controller.status().enabled, true);
});

test('walking consent defaults off and changes revoke the previous sharing session before enabling another',async t=>{
  const f=fixture();t.after(()=>f.controller.stop());await f.controller.attach(f.native);
  f.controller.setEnabled(true);await flush();
  assert.equal(f.controller.status().mobility,false);
  const first=f.requests.find(r=>r.path.endsWith('/control')&&r.body.enabled)!;
  assert.equal(first.body.mobility_enabled,undefined);
  f.controller.setMobilityEnabled(true);await flush();await f.controller.pump();
  const controls=f.requests.filter(r=>r.path.endsWith('/control'));
  assert.equal(controls[1]!.body.enabled,false);assert.equal(controls[1]!.body.sharing_id,first.body.sharing_id);
  assert.equal(controls[2]!.body.mobility_enabled,true);assert.notEqual(controls[2]!.body.sharing_id,first.body.sharing_id);
  f.controller.setMobilityEnabled(false);await flush();await f.controller.pump();
  assert.equal(f.requests.filter(r=>r.path.endsWith('/control')).at(-1)!.body.mobility_enabled,undefined);
  f.controller.setMobilityEnabled(true);await flush();await f.controller.pump();
  f.setTarget('https://another-relay.example.test');await f.controller.pump();
  assert.equal(f.controller.status().enabled,false);assert.equal(f.controller.status().mobility,false);
});

test('delayed old enable cannot restore walking consent after revocation',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dot-delayed-consent-'));
  let context!:LocationContext,release!:()=>void,hold=true;
  const f=fixture(async(path,raw)=>{
    const body=raw as any;
    if(path.endsWith('/control')&&body.enabled&&hold){hold=false;await new Promise<void>(r=>{release=r;});}
    return path.endsWith('/control')?context.control(body,'owner'):context.update(body,'owner');
  });
  context=new LocationContext(join(dir,'location.json'),new WebhookSender(async()=>({status:200,body:'{}'})),[],async()=>({}),f.now);
  t.after(async()=>{await f.controller.stop();context.close();rmSync(dir,{recursive:true,force:true});});
  await f.controller.attach(f.native);f.controller.setEnabled(true);await flush();
  const old=f.requests[0].body.sharing_id;
  f.controller.setMobilityEnabled(true);await flush();
  assert.equal(f.requests.at(-1)?.body.enabled,false);
  release();await flush();await f.controller.pump();
  const controls=f.requests.filter(r=>r.path.endsWith('/control'));
  assert.notEqual(controls.at(-1)!.body.sharing_id,old);
  assert.equal(controls.at(-1)!.body.mobility_enabled,true);
  assert.throws(()=>context.control({sharing_id:old,enabled:true,mobility_enabled:false},'owner'),/revoked/);
  assert.equal(f.controller.status().state,'sharing');
});

for(const mobility of [undefined,true,false])test(`restored consent preserves only explicit walking preference ${mobility}`,async t=>{
  const f=fixture();t.after(()=>f.controller.stop());
  f.nativeStore.set('dot-location-sharing-v1',JSON.stringify({enabled:true,origin:'https://relay.example.test',stops:[],...(mobility===undefined?{}:{mobility})}));
  await f.controller.attach(f.native);await flush();await f.controller.pump();
  assert.equal(f.controller.status().mobility,mobility===true);
  assert.equal(f.requests.find(r=>r.path.endsWith('/control')&&r.body.enabled)?.body.mobility_enabled,mobility===true?true:undefined);
});


test('default walking opt-out remains compatible with legacy strict location controls',async t=>{
  const f=fixture((path,raw)=>{
    const body=raw as any;
    if(path.endsWith('/control')){
      assert.deepEqual(Object.keys(body).sort(),['enabled','sharing_id']);
      return {enabled:body.enabled};
    }
    return {locationSharing:true,locationFresh:true};
  });
  t.after(()=>f.controller.stop());await f.controller.attach(f.native);
  f.controller.setEnabled(true);await flush();
  assert.equal(f.controller.status().state,'sharing');
});
