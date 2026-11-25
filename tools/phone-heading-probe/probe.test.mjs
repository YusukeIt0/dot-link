import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { appLocationFromJson } from '@evenrealities/even_hub_sdk';

async function fixture(t, { lateBridge = false, permission = 'granted' } = {}) {
  const ui = new Map(), events = new Map(), calls = [];
  const element = id => {
    if (!ui.has(id)) ui.set(id, { setAttribute() {} });
    return ui.get(id);
  };
  const win = { location: { search: '' }, isSecureContext: true,
    addEventListener(k, cb) { events.set(k, cb); }, removeEventListener(k) { events.delete(k); },
    DeviceOrientationEvent: { requestPermission() { calls.push('gesture'); return Promise.resolve(permission); } },
  };
  const inject = () => { win.flutter_inappwebview = { callHandler() {} }; };
  if (!lateBridge) inject();
  const nativeAngles = [319, 49, 319];
  const bridge = { async getAppLocation() {
    calls.push('fix');
    return appLocationFromJson({ latitude: 12.345678, longitude: 98.765432, heading: nativeAngles.shift(), timestamp: Date.now() });
  } };
  const doc = { getElementById: element, addEventListener(k, cb) { events.set(k, cb); } };
  const vars = { window: win, document: doc, phoneProbeFixtureBridge: bridge };
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(vars)) Object.defineProperty(globalThis, k, { value, configurable: true });
  t.mock.timers.enable({ apis: ['setTimeout','Date'], now: 1800000000000 });
  t.mock.method(performance, 'now', () => Date.now() - 1800000000000);
  const sdk = import.meta.resolve('@evenrealities/even_hub_sdk');
  const stub = `export {AppLocationAccuracy} from ${JSON.stringify(sdk)};
    export async function waitForEvenAppBridge() { return globalThis.phoneProbeFixtureBridge; }`;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@evenrealities/even_hub_sdk' && context.parentURL?.includes('/phone-heading-probe/probe.js?')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
    }
    return next(specifier, context);
  } });
  t.after(() => {
    hooks.deregister();
    for (const [k, value] of Object.entries(saved)) {
      if (value) Object.defineProperty(globalThis, k, value);
      else delete globalThis[k];
    }
  });
  await import(new URL('./probe.js?test=' + encodeURIComponent(t.name), import.meta.url));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function mark(angle, options = {}) {
    element('measure').onclick();
    await flush();
    t.mock.timers.tick(400);
    if (angle != null) events.get('deviceorientation')?.({ type: 'deviceorientation',
      webkitCompassHeading: angle, webkitCompassAccuracy: 6, alpha: 7, absolute: false });
    if (options.hide) { doc.hidden = true; events.get('visibilitychange')(); }
    t.mock.timers.tick(1700);
    await flush();
  }
  return { element, events, inject, calls, mark, flush, report: () => JSON.parse(element('result').value) };
}

test('probes both real entry points across the wrap without exporting positions or absolute angles', async t => {
  const f = await fixture(t, { lateBridge: true });
  f.inject(); f.events.get('flutterInAppWebViewPlatformReady')();
  await f.flush();
  for (const a of [345, 75, 345]) await f.mark(a);
  const r = f.report();
  assert.deepEqual(f.calls, ['gesture', 'fix', 'fix', 'fix']);
  assert.equal(r.reason, 'completed');
  assert.equal(r.bridgeState, 'ready');
  assert.deepEqual(r.sources.webkitCompass.changes, [0,90,0]);
  assert.deepEqual(r.sources.evenLocation.changes, [0,90,0]);
  assert.equal(r.sources.evenLocation.outcome, 'tracks right turn and return');
  assert.equal(r.sources.flatAbsoluteAlpha.outcome, 'incomplete');
  assert.doesNotMatch(JSON.stringify(r), /12\.345678|98\.765432|319|345|latitude|longitude/);
  assert.equal(f.events.has('deviceorientation'), false);
});

test('a missing orientation stream stays empty while native phone fixes can be measured', async t => {
  const f = await fixture(t, { permission: 'denied' });
  await f.mark(null); await f.mark(null); await f.mark(null);
  const r = f.report();
  assert.equal(r.permission, 'denied');
  assert.equal(r.sources.webkitCompass.outcome, 'incomplete');
  assert.equal(r.sources.evenLocation.outcome, 'tracks right turn and return');
});

test('hiding the page stops sampling and discards an unfinished pose', async t => {
  const f = await fixture(t);
  await f.mark(73, { hide: true });
  assert.equal(f.report().reason, 'page hidden');
  assert.deepEqual(f.report().poses, []);
  assert.equal(f.events.has('deviceorientationabsolute'), false);
});
