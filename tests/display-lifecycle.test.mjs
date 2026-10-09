import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import * as sdk from '@evenrealities/even_hub_sdk';

const mainUrl = new URL('../src/main.ts', import.meta.url);
const source = await readFile(mainUrl, 'utf8');
const dependencies = { ...sdk };
for (const match of source.matchAll(/import\s+\{[^}]*\}\s+from\s+'(\.\/[^']+)'/g)) {
  Object.assign(dependencies, await import(new URL(match[1], mainUrl).href));
}
const script = stripTypeScriptTypes(source
  .replace(/import\s+[\s\S]*?from\s+'[^']+';\n/g, '')
  .replace(/import '\.\/style.css';/, '')
  .replace('import.meta.env.VITE_APP_VERSION', "'test'"));
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

async function launch(options = {}) {
  let now = 0, timerId = 0, receiver;
  const timers = new Map(); const elements = new Map(); const listeners = new Map();
  const calls = []; const requests = []; const physical = new Map();
  const saved = new Map(options.nativePairing ? [] : [['g2-device-token', 'x'.repeat(43)]]);
  const nativeSaved = new Map(options.nativePairing ? [['dot-relay-native-v1', JSON.stringify(options.nativePairing)]] : []);
  let resumeAttempts = 0;
  let writeGate;
  const schedule = (callback, ms, repeat = false) => {
    const id = ++timerId; timers.set(id, { callback, at: now + ms, ms, repeat }); return id;
  };
  const clock = {now: () => now, schedule, cancel: id => timers.delete(id)};
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent: '', value: '', dataset: {}, checked: false, disabled: false,
      before() {}, after() {}, setAttribute() {}, addEventListener() {}, close() {}, pause() {}, showModal() {},
      click() { return this.onclick?.(); }});
    return elements.get(id);
  };
  const listen = (name, callback) => { listeners.set(name, callback); };
  const bridge = {
    async createStartUpPageContainer(page) { calls.push(['create']); for (const c of page.textObject) physical.set(c.containerID, c.content); return 0; },
    async textContainerUpgrade(update) {
      calls.push(['text', update.containerID, update.content]);
      if (writeGate) { const gate = writeGate; writeGate = undefined; await gate; }
      physical.set(update.containerID, update.content); return true;
    },
    onEvenHubEvent(callback) { receiver = callback; },
    async audioControl(open) { calls.push(['mic', open]); return true; },
    async imuControl(open) { calls.push(['imu', open]); return true; },
    async shutDownPageContainer(mode) { calls.push(['exit', mode]); return true; },
    async getLocalStorage(k) { return nativeSaved.get(k) ?? ''; },
    async setLocalStorage(k, v) { nativeSaved.set(k, v); return true; },
  };
  const local = {getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k)};
  const context = vm.createContext({ ...dependencies,
    DisplayStandby: class extends dependencies.DisplayStandby { constructor(p, changed) { super(p, changed, clock); } },
    waitForEvenAppBridge: async () => bridge,
    document: {documentElement: {}, body: {dataset: {}}, hidden: false, getElementById: element,
      querySelector: element, querySelectorAll: () => [], createComment: element, addEventListener: listen},
    window: {addEventListener: listen, speechSynthesis: {cancel() {}}}, navigator: {language: 'ja'},
    localStorage: local, sessionStorage: local, location: {origin: options.nativePairing ? 'http://127.0.0.1:57157' : 'https://test.invalid', hash: '', pathname: '/', search: ''},
    history: {replaceState() {}}, performance: {now: () => now}, crypto, console, URLSearchParams, AbortController, AbortSignal, Uint8Array, Blob, TextEncoder,
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
    fetch: (url, init) => {
      if (String(url).endsWith('/api/pair/resume')) {
        resumeAttempts++;
        assert.equal(JSON.parse(init.body).resumeToken, options.nativePairing.resumeToken);
        calls.push(['resume']);
        if (options.failResumeOnce && resumeAttempts === 1) return Promise.reject(new Error('Temporary offline'));
        return Promise.resolve({status:200,ok:true,json:async()=>({...options.nativePairing,token:'n'.repeat(43)})});
      }
      if (String(url).endsWith('/api/timings')) return Promise.resolve({status: 204, ok: true});
      assert.equal(url, options.nativePairing ? `${options.nativePairing.origin}/api/updates` : '/api/updates', 'fixture must never access another API');
      if (options.nativePairing) assert.equal(init.headers.Authorization, `Bearer ${'n'.repeat(43)}`, 'only resumed token reaches data API');
      return new Promise(resolve => requests.push(resolve));
    },
  });
  vm.runInContext(script, context); await flush();
  assert.equal(element('g2-diagnostic').textContent, 'G2_READY');
  const snapshot = (messages = []) => ({revision: 'same', status: {subscribed: true, deviceName: 'Test Mac'}, messages});
  const deliver = async value => {
    assert.ok(requests.length, 'receiver must still be waiting');
    requests.shift()({ok: true, status: 200, json: async () => structuredClone(value)}); await flush();
  };
  if (!options.failResumeOnce) await deliver(snapshot());
  const advance = async ms => {
    const end = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      if (next[1].repeat) next[1].at += next[1].ms; else timers.delete(next[0]);
      next[1].callback(); await flush();
    }
    now = end; await flush();
  };
  return {calls, physical, element, saved, nativeSaved, timers, snapshot, deliver, advance, context,
    emit: async event => {receiver(event); await flush();},
    evaluate: async code => {vm.runInContext(code, context); await flush();},
    gate: () => {let release; writeGate = new Promise(resolve => {release = resolve;}); return release;},
    close: async () => {vm.runInContext('stopSession()', context); await flush();},
    hidden: () => vm.runInContext('standby.hidden', context),
  };
}

const doubleTap = {textEvent: {eventType: sdk.OsEventTypeList.DOUBLE_CLICK_EVENT}};
const singleTap = {textEvent: {}}; // zero enum omitted by the native host
const proactive = id => ({id, text: '', reply: `Synthetic message ${id}`, status: 'replied', kind: 'proactive'});

test('full app hides all 3 containers, keeps receiving, and wakes on a new autonomous message', async t => {
  const app = await launch(); t.after(app.close);
  await app.advance(30_000); assert.equal(app.hidden(), true);
  assert.deepEqual([...app.physical.values()], [' ', ' ', ' ']);
  const count = app.calls.length;
  for (let i = 0; i < 100; i++) await app.deliver(app.snapshot());
  assert.equal(app.calls.length, count, 'unchanged polls must not relight the display');
  await app.deliver(app.snapshot([proactive('one')]));
  assert.equal(app.hidden(), false); assert.match(app.physical.get(2), /Synthetic message one/);
  await app.advance(29_999); assert.equal(app.hidden(), false);
  await app.advance(1); assert.equal(app.hidden(), true);
  await app.advance(6 * 60_000);
  assert.equal(app.calls.some(c => c[0] === 'exit'), false, 'inactivity must never exit');
});

test('default double wake consumes the gesture; configurable single wake also swallows a trailing double', async t => {
  const app = await launch(); t.after(app.close);
  await app.deliver(app.snapshot([proactive('last')])); await app.advance(30_000);
  await app.emit(singleTap); assert.equal(app.hidden(), true);
  await app.emit(doubleTap); assert.equal(app.hidden(), false);
  assert.match(app.physical.get(2), /Synthetic message last/);
  await app.emit(doubleTap); assert.equal(app.calls.some(c => c[0] === 'exit'), false);
  await app.advance(700); await app.emit(doubleTap);
  assert.deepEqual(app.calls.filter(c => c[0] === 'exit'), [['exit', 1]], 'visible normal double keeps the existing exit dialog');
  app.element('display-wake-tap').value = 'single'; app.element('display-idle').value = '5';
  app.element('display-settings-form').onsubmit({preventDefault() {}}); await flush();
  assert.equal(JSON.parse(app.saved.get('dot-display-v1')).wakeTap, 'single');
  await app.advance(5000); await app.emit(singleTap); assert.equal(app.hidden(), false);
  await app.advance(100); await app.emit(doubleTap);
  assert.equal(app.calls.filter(c => c[0] === 'exit').length, 1);
});

test('recording, recognition and offline reply-wait do not blank; result receives a full interval', async t => {
  const app = await launch(); t.after(app.close);
  await app.emit({sysEvent: {eventType: sdk.OsEventTypeList.LONG_PRESS_EVENT}});
  await app.advance(60_000); assert.equal(app.hidden(), false);
  assert.ok(app.calls.some(c => c[0] === 'mic' && c[1] === true));
  await app.emit({sysEvent: {eventType: sdk.OsEventTypeList.LONG_PRESS_RELEASE_EVENT}});
  for (const phase of ['recognizing', 'sending', 'waiting']) {
    await app.evaluate(`progress.begin('job', 'recognizing'); progress.setPhase('${phase}'); progress.connection='offline'; refreshStatus();`);
    await app.advance(90_000); assert.equal(app.hidden(), false);
  }
  await app.deliver(app.snapshot([{id: 'job', text: 'Synthetic request', reply: 'Synthetic reply', status: 'replied'}]));
  await app.advance(29_999); assert.equal(app.hidden(), false);
  await app.advance(1); assert.equal(app.hidden(), true);
});

test('IMU wakes only on a new head raise; holding the head up does not undo the idle timeout', async t => {
  const app = await launch(); t.after(app.close);
  assert.ok(app.calls.some(c => c[0] === 'imu' && c[1] === true));
  const imu = angle => ({sysEvent: {eventType: sdk.OsEventTypeList.IMU_DATA_REPORT,
    imuData: {x: Math.sin(angle * Math.PI / 180), y: 0, z: Math.cos(angle * Math.PI / 180)}}});
  await app.advance(30_000); await app.emit(imu(0)); await app.emit(imu(25));
  await app.advance(250); await app.emit(imu(25)); assert.equal(app.hidden(), false);
  for (let i = 0; i < 121; i++) { await app.advance(250); await app.emit(imu(25)); }
  assert.equal(app.hidden(), true);
  app.element('display-head-raise').checked = false;
  app.element('display-settings-form').onsubmit({preventDefault() {}}); await flush();
  assert.ok(app.calls.some(c => c[0] === 'imu' && c[1] === false));
  await app.advance(30_000); await app.emit(imu(0)); await app.emit(imu(30));
  await app.advance(250); await app.emit(imu(30)); assert.equal(app.hidden(), true);
});

test('new arrival wins a slow in-flight blank, with no later stale erase', async t => {
  const app = await launch(); t.after(app.close);
  const release = app.gate();
  await app.advance(30_000); assert.equal(app.hidden(), true);
  await app.deliver(app.snapshot([proactive('race')])); assert.equal(app.hidden(), false);
  release(); await flush();
  assert.match(app.physical.get(2), /Synthetic message race/);
  assert.notEqual(app.physical.get(3), ' ');
});


test('full app restores native pairing into empty updated WebView and resumes its changed port before reading data', async t => {
  const credentials = {origin:'https://mac.tailtest.ts.net',token:'o'.repeat(43),resumeToken:'r'.repeat(43),appOrigin:'http://127.0.0.1:55895',expiresAt:Date.now()+100000};
  const app = await launch({nativePairing:credentials}); t.after(app.close);
  assert.equal(app.calls.filter(c=>c[0]==='resume').length,1);
  assert.equal(JSON.parse(app.saved.get('dot-relay-v1')).appOrigin,'http://127.0.0.1:57157');
  assert.equal(JSON.parse(app.nativeSaved.get('dot-relay-native-v1')).token,'n'.repeat(43));
  assert.equal(app.element('dot-status').textContent,'Test Mac · Dot接続済み');
  await app.deliver(app.snapshot([proactive('after-update')]));
  assert.match(app.physical.get(2),/after-update/);
});

test('temporary recovery failure preserves credentials and retries without asking for a new pairing code', async t => {
  const credentials = {origin:'https://mac.tailtest.ts.net',token:'o'.repeat(43),resumeToken:'r'.repeat(43),appOrigin:'http://127.0.0.1:55895',expiresAt:Date.now()+100000};
  const app = await launch({nativePairing:credentials,failResumeOnce:true}); t.after(app.close);
  assert.equal(JSON.parse(app.nativeSaved.get('dot-relay-native-v1')).resumeToken,credentials.resumeToken);
  // LiveUpdates is imported as a real module and owns its own retry timer.
  await new Promise(resolve=>setTimeout(resolve,1100)); await flush();
  assert.equal(app.calls.filter(c=>c[0]==='resume').length,2);
  await app.deliver(app.snapshot());
  assert.equal(app.element('dot-status').textContent,'Test Mac · Dot接続済み');
});

test('IMU reports without coordinates and unknown system events are not user activity', async t => {
  const app = await launch(); t.after(app.close);
  for (let n=0; n<40; n++) {
    await app.emit({sysEvent:{eventType:sdk.OsEventTypeList.IMU_DATA_REPORT}});
    await app.emit({sysEvent:{eventType:99}});
    await app.advance(1000);
  }
  assert.equal(app.hidden(),true,'sensor/status reports must not keep resetting the 30-second idle deadline');
  assert.deepEqual([...app.physical.values()],[' ',' ',' ']);
});


test('head raises while already visible do not keep postponing the initial 30-second timeout', async t => {
  const app = await launch(); t.after(app.close);
  const imu = angle => ({sysEvent:{eventType:sdk.OsEventTypeList.IMU_DATA_REPORT,imuData:{x:Math.sin(angle*Math.PI/180),y:0,z:Math.cos(angle*Math.PI/180)}}});
  for(let n=0;n<29;n++) {
    await app.emit(imu(0)); await app.advance(400);
    await app.emit(imu(25)); await app.advance(200);
    await app.emit(imu(25)); await app.advance(400);
  }
  assert.equal(app.hidden(),false);
  await app.advance(1000); assert.equal(app.hidden(),true);
  await app.emit(imu(0)); await app.advance(400);
  await app.emit(imu(25)); await app.advance(200); await app.emit(imu(25));
  assert.equal(app.hidden(),false,'the same gesture still wakes when hidden');
});
