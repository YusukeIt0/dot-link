import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { evenHubEventFromJson, OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { bearingCandidates } from './navigation/bearing.js';

test('retains named numeric angles, including zero, and never reads unrelated fields', () => {
  const original = { eventType: 8, imuData: { magnetic_heading: 0, orientation: { yaw: -12 } },
    compassInfoMsg: { degrees: 287 }, trueHeading: -1, heading: '95', azimuth: Infinity };
  for (const key of ['location', 'route', 'audioPcm', 'text']) {
    Object.defineProperty(original, key, { enumerable: true, get() { throw new Error(key); } });
  }
  assert.deepEqual(bearingCandidates(original), {
    'imudata.magneticheading': 0, 'imudata.orientation.yaw': -12, 'compassinfomsg.degrees': 287,
  });
  assert.deepEqual(bearingCandidates({ degrees: 52, location: { heading: 185 }, route: { heading: 181 } }), {});
});

// The real SDK parses events. Only its bridge factory is replaced so any
// unplanned host command fails and a cached exit can be delivered immediately.
async function fixture(t, { connected = true, exitOnSubscribe = false } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { disabled: true, setAttribute() {} });
    return elements.get(id);
  }
  const callbacks = {};
  const calls = [];
  const bridge = {
    async getDeviceInfo() {
      calls.push('getDeviceInfo');
      return { model: 'g2', status: { isConnected: () => connected } };
    },
    onEvenHubEvent(callback) {
      calls.push('listen');
      callbacks.event = callback;
      if (exitOnSubscribe) callback(evenHubEventFromJson({ type: 'sysEvent', jsonData: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } }));
      return () => { calls.push('unsubscribe'); delete callbacks.event; };
    },
  };
  const doc = {
    documentElement: {}, getElementById: element, querySelector: element, querySelectorAll: () => [],
    addEventListener: (name, cb) => { callbacks[name] = cb; },
  };
  const win = { location: { search: '?lang=ja' }, addEventListener: doc.addEventListener };
  const values = { window: win, document: doc, testNavigationBridge: bridge };
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const sdk = import.meta.resolve('@evenrealities/even_hub_sdk');
  const stub = `export {OsEventTypeList} from ${JSON.stringify(sdk)};
    export async function waitForEvenAppBridge() { return globalThis.testNavigationBridge; }`;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@evenrealities/even_hub_sdk' && context.parentURL?.includes('/navigation/listen.js?')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
    }
    return next(specifier, context);
  } });
  t.after(() => {
    hooks.deregister();
    for (const key of Object.keys(values)) {
      if (key in saved) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  await import(new URL('./navigation/listen.js?test=' + encodeURIComponent(t.name), import.meta.url));
  const emit = jsonData => callbacks.event(evenHubEventFromJson({ type: 'sysEvent', jsonData }));
  return { element, doc, calls, callbacks, emit, result: () => JSON.parse(element('result').value) };
}

test('listens without starting a HUD or IMU and keeps the map observation separate from candidate events', async t => {
  const f = await fixture(t);
  assert.equal(f.doc.documentElement.lang, 'ja');
  assert.equal(f.element('start').disabled, false);
  f.element('start').onclick();
  f.emit({ eventType: OsEventTypeList.IMU_DATA_REPORT, imuData: { x: 0, magneticHeading: 0 } });
  f.emit({ location: { heading: 159, latitude: 32 }, route: { heading: 181 } });
  t.mock.timers.tick(300);
  f.emit({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT });
  f.element('finish').onclick();
  const r = f.result();
  assert.deepEqual(f.calls, ['getDeviceInfo', 'listen', 'unsubscribe']);
  assert.equal(r.hostEvents, 3);
  assert.equal(r.imuReports, 1);
  assert.equal(r.candidateEvents, 1);
  assert.equal(r.mapAtEnd, 'stayed visible');
  assert.deepEqual(r.values, [{ tMs: 0, fields: { 'imudata.magneticheading': 0 } }]);
  assert.deepEqual(r.lifecycle, [{ tMs: 300, type: OsEventTypeList.FOREGROUND_EXIT_EVENT }]);
  assert.doesNotMatch(JSON.stringify(r), /route|latitude|location/);
});

test('records a lost map before any subscription or sample', async t => {
  const f = await fixture(t);
  f.element('gone').onclick();
  assert.deepEqual(f.calls, ['getDeviceInfo']);
  assert.equal(f.result().mapAtStart, 'unconfirmed');
  assert.equal(f.result().mapAtEnd, 'disappeared');
  assert.equal(f.result().hostEvents, 0);
});

test('times out without assuming the map stayed up, then accepts its observed state', async t => {
  const f = await fixture(t);
  f.element('start').onclick();
  t.mock.timers.tick(60000);
  assert.equal(f.result().reason, 'time limit');
  assert.equal(f.result().mapAtEnd, 'unconfirmed');
  assert.equal(f.callbacks.event, undefined);
  f.element('gone').onclick();
  assert.equal(f.result().mapAtEnd, 'disappeared');
  assert.equal(f.result().elapsedMs, 60000);
  assert.deepEqual(f.calls, ['getDeviceInfo', 'listen', 'unsubscribe']);
});

test('releases a listener that delivers host exit while registering', async t => {
  const f = await fixture(t, { exitOnSubscribe: true });
  f.element('start').onclick();
  assert.equal(f.result().reason, 'host exit');
  assert.equal(f.result().mapAtEnd, 'unconfirmed');
  assert.equal(f.callbacks.event, undefined);
  assert.deepEqual(f.calls, ['getDeviceInfo', 'listen', 'unsubscribe']);
});

test('keeps sampling disabled without a connected G2', async t => {
  const f = await fixture(t, { connected: false });
  assert.equal(f.element('start').disabled, true);
  assert.match(f.element('status').textContent, /G2の接続/);
  assert.deepEqual(f.calls, ['getDeviceInfo']);
});
