import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { evenHubEventFromJson } from '@evenrealities/even_hub_sdk';
import { limits, poses } from './measurement.js';

const sdk = import.meta.resolve('@evenrealities/even_hub_sdk');

// Use the real SDK parser and page models with a local synthetic host and clock.
async function fixture(t, startResult = true, language = 'en', mode = '') {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  };
  const calls = [];
  const handlers = {};
  const bridge = {
    async getDeviceInfo() { return { model: 'g2', sn: 'fixture-only', status: { isConnected: () => true } }; },
    async createStartUpPageContainer() { calls.push('page'); return 0; },
    async textContainerUpgrade() {},
    async imuControl(enabled, pace) { calls.push([enabled, pace]); return enabled ? startResult : true; },
    onEvenHubEvent(callback) { handlers.event = callback; return () => { delete handlers.event; }; },
    onDeviceStatusChanged(callback) { handlers.status = callback; return () => { delete handlers.status; }; },
  };
  const doc = { documentElement: {}, getElementById: element, addEventListener(name, cb) { handlers[name] = cb; } };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  const saved = new Map();
  const win = { location: { search: '?' + new URLSearchParams({lang: language, mode}) }, addEventListener() {} };
  for (const [key, value] of Object.entries({ document: doc, window: win, probeTestBridge: bridge })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const stub = `export {CreateStartUpPageContainer, ImuReportPace, OsEventTypeList, TextContainerProperty, TextContainerUpgrade} from ${JSON.stringify(sdk)};
    export async function waitForEvenAppBridge() { return globalThis.probeTestBridge; }`;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@evenrealities/even_hub_sdk' && context.parentURL?.includes('/g2-imu-probe/probe.js?')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  t.after(() => {
    hooks.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await import(new URL('./probe.js?test=' + encodeURIComponent(t.name), import.meta.url));
  await flush();
  assert.equal(element('start').disabled, false);
  element('start').onclick();
  await flush();
  function sample(imuData) {
    handlers.event?.(evenHubEventFromJson({ type: 'sysEvent', jsonData: { eventType: 8, imuData } }));
  }
  return { element, handlers, doc, calls, sample, flush, result: () => JSON.parse(element('data').value) };
}

test('Japanese prompts permit a full unreferenced rotation without knowing north', async t => {
  const f = await fixture(t, true, 'ja');
  assert.equal(f.doc.documentElement.lang, 'ja');
  assert.match(f.element('status').textContent, /正面/);
  assert.match(f.element('start').textContent, /測定を始める/);
  f.element('mark').onclick();
  t.mock.timers.tick(limits.settleMs);
  t.mock.timers.tick(limits.holdMs);
  assert.match(f.element('status').textContent, /右に90度/);
  f.element('stop').onclick();
  await f.flush();
  assert.equal(f.result().marks[0].pose, 'F1');
  assert.match(f.result().reference, /unknown/);
});

test('a late start is turned off after the operator has already stopped', async t => {
  const pending = Promise.withResolvers();
  const f = await fixture(t, pending.promise);
  f.element('stop').onclick();
  await f.flush();
  assert.deepEqual(f.calls, ['page', [true, 200], [false, 200]]);
  pending.resolve(true);
  await f.flush();
  assert.deepEqual(f.calls, ['page', [true, 200], [false, 200], [false, 200]]);
  assert.equal(f.result().rows.length, 0);
  assert.equal(f.handlers.event, undefined);
});

test('a rejected IMU request remains an empty, inconclusive run', async t => {
  const f = await fixture(t, false);
  assert.equal(f.result().stopReason, 'IMU start rejected');
  assert.deepEqual(f.result().summary, []);
  assert.equal(f.result().rows.length, 0);
});

test('a normal HUD can run a ten-second active comparison without any pose marks', async t => {
  const f = await fixture(t, true, 'ja', 'navigation');
  assert.match(f.element('title').textContent, /ナビと文字表示/);
  f.sample({ x: 0, y: 0, z: 1, compassInfoMsg: { degrees: 0 }, secret: 'discard-me' });
  f.sample({ x: 0, y: 1, z: 0, route: { heading: 123 } });
  t.mock.timers.tick(10000);
  await f.flush();
  const r = f.result();
  assert.equal(r.mode, 'active navigation comparison');
  assert.equal(r.elapsedMs, 10000);
  assert.equal(r.completeXYZ, 2);
  assert.equal(r.namedMotionReports, 1);
  assert.deepEqual(r.values, [{tMs: 0, fields: {'imudata.compassinfomsg.degrees': 0}}]);
  assert.deepEqual([r.startupAcknowledged, r.imuStartAcknowledged, r.imuOffAcknowledged], [true, true, true]);
  assert.deepEqual(f.calls, ['page', [true, 200], [false, 200]]);
  assert.doesNotMatch(JSON.stringify(r), /route|discard-me|fixture-only/);
});

test('an active comparison records a rejected IMU start separately from a silent stream', async t => {
  const f = await fixture(t, false, 'ja', 'navigation');
  const r = f.result();
  assert.equal(r.imuStartAcknowledged, false);
  assert.equal(r.stopReason, 'IMU start rejected');
  assert.equal(r.completeXYZ, 0);
  assert.equal(r.imuOffAcknowledged, true);
});

test('both rotations, tilt and roll stay distinct, zero survives, and extra private fields are dropped', async t => {
  const f = await fixture(t);
  for (const [pose] of poses) {
    f.sample({ x: 1, y: 1, z: 1 });
    f.element('mark').onclick();
    f.sample({ x: 1, y: 2, z: 3 });
    t.mock.timers.tick(limits.settleMs);
    f.sample({ x: pose === 'pitch' ? 0.5 : 0, y: pose === 'roll' ? 0.5 : 0, z: 1,
      magneticHeading: 0, secretText: 'must-not-be-recorded' });
    f.sample({ x: 0, z: 1 }); // missing Y must not become zero
    t.mock.timers.tick(limits.holdMs);
  }
  await f.flush();
  const result = f.result();
  assert.deepEqual(f.calls, ['page', [true, 200], [false, 200]]);
  assert.equal(result.imuOffAcknowledged, true);
  assert.equal(result.stopReason, 'all poses marked');
  assert.equal(result.marks.length, 12);
  assert.equal(result.rows.length, 48);
  assert.equal(result.rows[2].tMs, limits.settleMs);
  assert.equal(result.marks[1].alignedMs, limits.settleMs + limits.holdMs);
  assert.equal(result.rows[2].hostMotion['imudata.magneticheading'], 0);
  assert.equal(result.rows[3].y, null);
  assert.equal(result.summary.length, 12);
  for (const s of result.summary) { assert.equal(s.complete, 1); assert.equal(s.received, 2); }
  assert.equal(result.summary.find(s => s.pose === 'pitch').means.x, 0.5);
  assert.equal(result.summary.find(s => s.pose === 'roll').means.y, 0.5);
  assert.doesNotMatch(JSON.stringify(result), /fixture-only|secretText|must-not-be-recorded/);
});

for (const reason of ['time limit', 'sample limit', 'page hidden', 'device disconnected or in case', 'host exited', 'operator stopped']) {
  test(`stops sampling on ${reason}`, async t => {
    const f = await fixture(t);
    f.sample({ x: 1, y: 0, z: 0 });
    if (reason === 'time limit') t.mock.timers.tick(limits.sessionMs);
    if (reason === 'sample limit') for (let i = 1; i < limits.samples; i++) f.sample({ x: 0, y: 0, z: 1 });
    if (reason === 'page hidden') { f.doc.hidden = true; f.handlers.visibilitychange(); }
    if (reason === 'device disconnected or in case') f.handlers.status({ sn: 'fixture-only', isDisconnected: () => true });
    if (reason === 'host exited') f.handlers.event(evenHubEventFromJson({ type: 'sysEvent', jsonData: { eventType: 7 } }));
    if (reason === 'operator stopped') f.element('stop').onclick();
    await f.flush();
    assert.equal(f.result().stopReason, reason);
    assert.equal(f.result().imuOffAcknowledged, true);
    assert.deepEqual(f.calls, ['page', [true, 200], [false, 200]]);
    assert.equal(f.handlers.event, undefined);
    assert.equal(f.handlers.status, undefined);
    assert.equal(f.result().rows.length, reason === 'sample limit' ? limits.samples : 1);
  });
}
