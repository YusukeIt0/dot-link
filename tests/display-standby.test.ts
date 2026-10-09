import test from 'node:test';
import assert from 'node:assert/strict';
import { DisplayStandby, HeadRaiseDetector, DEFAULT_DISPLAY_PREFERENCES, parseDisplayPreferences } from '../src/display-standby.ts';
import { DisplayPreferenceStore } from '../src/display-preferences.ts';

class Clock {
  time = 0;
  jobs = new Map<number, { at: number; callback: () => void }>();
  id = 0;
  now = () => this.time;
  schedule = (callback: () => void, ms: number) => { const id = ++this.id; this.jobs.set(id, { at: this.time + ms, callback }); return id; };
  cancel = (id: unknown) => { this.jobs.delete(id as number); };
  advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at; this.jobs.delete(next[0]); next[1].callback();
    }
    this.time = end;
  }
}
const prefs = () => ({ ...DEFAULT_DISPLAY_PREFERENCES });

test('idle hides once, never exits; activity restarts a full reading window', () => {
  const clock = new Clock(); const changes: boolean[] = [];
  const display = new DisplayStandby(prefs(), hidden => changes.push(hidden), clock);
  display.start(); clock.advance(29_999); assert.equal(display.hidden, false);
  clock.advance(1); assert.equal(display.hidden, true);
  clock.advance(86_400_000); assert.deepEqual(changes, [true]); assert.equal(clock.jobs.size, 0);
  display.activity(); clock.advance(29_999); assert.equal(display.hidden, false);
  clock.advance(1); assert.deepEqual(changes, [true, false, true]);
});

test('recording/transcription/wait protection spans idle deadlines, then starts a new window', () => {
  const clock = new Clock(); const display = new DisplayStandby(prefs(), () => {}, clock);
  display.start(); clock.advance(29_000); display.protect(true);
  clock.advance(300_000); assert.equal(display.hidden, false); assert.equal(clock.jobs.size, 0);
  display.protect(false); clock.advance(29_999); assert.equal(display.hidden, false);
  clock.advance(1); assert.equal(display.hidden, true);
});

test('default double wake consumes single, double and duplicates; later double is a normal action', () => {
  const clock = new Clock(); const display = new DisplayStandby(prefs(), () => {}, clock);
  display.start(); clock.advance(30_000);
  assert.equal(display.tap('single'), true); assert.equal(display.hidden, true);
  assert.equal(display.tap('double'), true); assert.equal(display.hidden, false);
  clock.advance(100); assert.equal(display.tap('double'), true);
  clock.advance(600); assert.equal(display.tap('double'), false);
});

test('single wake is configurable, and trailing double cannot become exit', () => {
  const clock = new Clock(); const display = new DisplayStandby({ ...prefs(), wakeTap: 'single', idleSeconds: 5 }, () => {}, clock);
  display.start(); clock.advance(5000); assert.equal(display.tap('single'), true);
  clock.advance(200); assert.equal(display.tap('double'), true); assert.equal(display.hidden, false);
  display.configure({ ...prefs(), idleSeconds: 0 }); clock.advance(86_400_000); assert.equal(display.hidden, false);
  display.stop(); assert.equal(clock.jobs.size, 0);
});

const vector = (degrees: number) => ({ x: Math.sin(degrees * Math.PI / 180), y: 0, z: Math.cos(degrees * Math.PI / 180) });
test('head wake uses chosen angle, dwell and rising edge; held-up head cannot keep waking', () => {
  const head = new HeadRaiseDetector({ ...prefs(), headAngle: 35 });
  assert.equal(head.sample(vector(0), 0), false);
  assert.equal(head.sample(vector(25), 100), false);
  assert.equal(head.sample(vector(36), 200), false);
  assert.equal(head.sample(vector(36), 400), true);
  assert.equal(head.sample(vector(40), 500), false);
  assert.equal(head.sample(vector(40), 800), false);
  head.sample(vector(0), 900); head.sample(vector(36), 1000);
  assert.equal(head.sample(vector(36), 1200), true);
});

test('calibrated head angle, disabled setting and invalid/stale samples', () => {
  const head = new HeadRaiseDetector({ ...prefs(), neutralPitch: 10 });
  head.sample(vector(10), 0); head.sample(vector(31), 100);
  assert.equal(head.sample(vector(31), 300), true);
  assert.ok(Math.abs(head.angle! - 21) < 0.01);
  assert.ok(Math.abs(head.calibration(400)! - 31) < 0.01);
  assert.equal(head.calibration(2400), undefined);
  assert.equal(head.sample({x: NaN, y: 0, z: 1}, 2500), false);
  assert.equal(head.sample({x: 0, y: 0, z: 0}, 2500), false);
  assert.equal(head.sample(vector(40), 5000), false); // no wake from stale high samples
  head.configure({ ...prefs(), headRaise: false });
  head.sample(vector(0), 6000); head.sample(vector(40), 6100);
  assert.equal(head.sample(vector(40), 6400), false);
});

test('settings persist across reopen, reject corrupt input, and restore native fallback', async () => {
  const local = new Map<string, string>();
  const storage = () => ({ getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => { local.set(k, v); } });
  const chosen = { ...prefs(), idleSeconds: 45, wakeTap: 'single' as const, headAngle: 37, headRaise: false, neutralPitch: 4 };
  const store = new DisplayPreferenceStore(storage);
  assert.equal(await store.save(chosen), true);
  assert.deepEqual(new DisplayPreferenceStore(storage).value, chosen);
  assert.equal(parseDisplayPreferences('{broken'), undefined);
  for (const patch of [{idleSeconds:-1}, {idleSeconds:1}, {headAngle:99}, {headRaise:'yes'}, {wakeTap:'triple'}, {neutralPitch:null}]) {
    assert.equal(parseDisplayPreferences(JSON.stringify({...chosen,...patch})), undefined);
  }
  local.clear();
  const restored = new DisplayPreferenceStore(storage);
  assert.equal(await restored.attach({ getLocalStorage: async () => JSON.stringify(chosen), setLocalStorage: async () => true }), true);
  assert.deepEqual(restored.value, chosen);
  assert.deepEqual(new DisplayPreferenceStore(storage).value, chosen);
});

test('slow native restore cannot overwrite edits; native saves remain in user order', async () => {
  let resolveRead!: (s: string) => void; const written: string[] = [];
  const store = new DisplayPreferenceStore(() => ({getItem: () => null, setItem: () => { throw new Error('blocked'); }}));
  const attaching = store.attach({getLocalStorage: () => new Promise(resolve => {resolveRead = resolve;}), setLocalStorage: async (_k, v) => { written.push(v); return true; }});
  const first = {...prefs(), idleSeconds: 60}; const last = {...prefs(), idleSeconds: 90};
  const saving = [store.save(first), store.save(last)]; resolveRead(JSON.stringify(prefs()));
  assert.equal(await attaching, false); assert.deepEqual(store.value, last);
  assert.deepEqual(await Promise.all(saving), [true, true]);
  assert.deepEqual(written.map(s => JSON.parse(s).idleSeconds), [60,90]);
});
