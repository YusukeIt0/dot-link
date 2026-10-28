import test from 'node:test';
import assert from 'node:assert/strict';
import { WakeEngine, type SpeakerRole, type WakeEvent } from '../src/wake-engine.ts';

function fixture(detections = [50], timestamps = [0.1, 0.2, 0.4, 0.5]) {
  let frames = 0, ready = false, resets = 0;
  const events: WakeEvent[] = [];
  const engine = new WakeEngine({
    createStream: () => { frames = 0; return { acceptWaveform: (_rate, samples) => { const previous = frames; frames += samples.length / 320; ready = detections.some(at => previous < at && frames >= at); }, free() {} }; },
    reset: () => { resets++; ready = false; }, isReady: () => ready, decode: () => { ready = false; },
    getResult: () => ({ keyword: 'HEY_DOT', start_time: 0, timestamps }), free() {},
  }, { acceptWaveform() {}, isDetected: () => true, isEmpty: () => true, reset() {}, free() {} }, event => events.push(event));
  engine.listen();
  const feed = (count: number, role?: SpeakerRole, bytes = 640) => {
    const pcm = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 2) pcm[i] = 123;
    for (let i = 0; i < count; i++) engine.append(pcm, role);
  };
  return { engine, events, feed, resets: () => resets };
}

test('only fully other-labelled cues are suppressed; missing and mixed roles preserve activation', () => {
  for (const role of ['self', 'other', 'unknown', undefined] as const) {
    const f = fixture(); f.feed(50, role);
    assert.equal(f.events.length, role === 'other' ? 0 : 1);
    assert.equal(f.resets(), role === 'other' ? 1 : 0); f.engine.dispose();
  }
  for (const role of ['self', 'unknown', undefined] as const) {
    const f = fixture(); f.feed(20, 'other'); f.feed(1, role); f.feed(29, 'other');
    assert.deepEqual(f.events, [{ type: 'wake' }]); f.engine.dispose();
  }
});

test('cue role uses its sample interval, not the last frame or pre-cue speech', () => {
  const f = fixture(); f.feed(5, 'self'); f.feed(30, 'other'); f.feed(15, 'self');
  assert.deepEqual(f.events, []); f.engine.dispose();
  const g = fixture(); g.feed(35, 'self'); g.feed(15, 'other');
  assert.deepEqual(g.events, [{ type: 'wake' }]); g.engine.dispose();
});

test('host frame size does not change gating and a single unknown sample permits the cue', () => {
  for (const size of [320, 640, 3200, 32000]) {
    const f = fixture(); f.feed(32000 / size, 'other', size);
    assert.deepEqual(f.events, []); f.engine.dispose();
  }
  const f = fixture(); f.feed(20, 'other'); f.feed(1, 'unknown', 2); f.feed(30, 'other');
  assert.deepEqual(f.events, [{ type: 'wake' }]); f.engine.dispose();
});

test('old, future, missing and invalid cue timestamps cannot suppress activation', () => {
  for (const [frames, times] of [[200, [.1, .5]], [50, [.1, 4]], [50, [NaN, .5]], [50, [.8, .5]]] as [number, number[]][]) {
    const f = fixture([frames], times); f.feed(frames, 'other');
    assert.deepEqual(f.events, [{ type: 'wake' }]); f.engine.dispose();
  }
});

test('suppression keeps listening; cancel and restart clear role history', () => {
  const f = fixture([50, 100]); f.feed(50, 'other'); assert.deepEqual(f.events, []);
  f.engine.cancel(); f.engine.listen(); f.feed(50);
  assert.deepEqual(f.events, [{ type: 'wake' }]); f.engine.dispose();
  const g = fixture([50, 160]); g.feed(50, 'other'); g.feed(110, 'self');
  assert.deepEqual(g.events, [{ type: 'wake' }]); g.engine.dispose();
});

test('other-labelled post-cue speech and manual takeover retain all audio', () => {
  const f = fixture(); f.feed(50, 'self'); f.engine.hold(); f.feed(25, 'other'); f.engine.finish();
  const clip = f.events[1]; assert.equal(clip.type, 'clip');
  if (clip.type === 'clip') { assert.equal(clip.seconds, .8); assert.equal(clip.wav?.length, 25644); }
  f.engine.dispose();
});

test('a sticky decoder match is consumed before the cue expires from the role ring', () => {
  let frame = 0, ready = false, matched = false, resets = 0;
  const events: WakeEvent[] = [];
  const engine = new WakeEngine({
    createStream: () => ({ acceptWaveform: () => { frame++; ready = true; if (frame === 50 || frame === 250) matched = true; }, free() {} }),
    isReady: () => ready, decode: () => { ready = false; },
    reset: () => { resets++; matched = false; },
    getResult: () => ({ keyword: matched ? 'HEY_DOT' : '', start_time: frame < 250 ? 0 : 4, timestamps: [.1, .5] }), free() {},
  }, { acceptWaveform() {}, isDetected: () => false, isEmpty: () => true, reset() {}, free() {} }, event => events.push(event));
  engine.listen();
  for (let i = 0; i < 200; i++) engine.append(new Uint8Array(640), 'other');
  assert.equal(resets, 1); assert.deepEqual(events, []);
  for (let i = 0; i < 50; i++) engine.append(new Uint8Array(640), 'self');
  assert.deepEqual(events, [{ type: 'wake' }]); engine.dispose();
});
