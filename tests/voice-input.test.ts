import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceInput } from '../src/voice-input.ts';
import type { WakeEvent } from '../src/wake-engine.ts';
import type { WakeDetector } from '../src/wake-detector.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  const calls: boolean[] = [], states: string[] = [], clips: string[] = [], detectorCalls: string[] = [];
  let emit!: (event: WakeEvent) => void, fail!: () => void;
  let closeOK = true, time = 0;
  const detector: WakeDetector = {
    listen: () => { detectorCalls.push('listen'); }, cancel: () => { detectorCalls.push('cancel'); },
    hold: () => { detectorCalls.push('hold'); }, finish: discard => emit({ type: 'clip', seconds: 1, ...(!discard ? { wav: new Uint8Array(46) } : {}) }),
    append: () => {}, dispose: () => { detectorCalls.push('dispose'); },
  };
  const voice = new VoiceInput({ microphone: async open => { calls.push(open); return open || closeOK; },
    loadWake: async (event, error) => { emit = event; fail = error; return detector; },
    onClip: (_wav, _seconds, source) => clips.push(source), onState: state => states.push(state),
    onError: message => assert.fail(message), onWakeState: state => states.push('wake:'+state), now: () => time });
  voice.setContext(true, false);
  return { voice, calls, states, clips, detectorCalls, emit: (event: WakeEvent) => emit(event), fail: () => fail(),
    close: (ok: boolean) => { closeOK = ok; }, clock: (value: number) => { time = value; } };
}

test('OFF leaves the microphone closed; enabling opens it once and blocking closes it', async () => {
  const s=setup(); assert.deepEqual(s.calls, []);
  await s.voice.setEnabled(true); await tick(); assert.deepEqual(s.calls,[true]);
  s.voice.setContext(true,true); await tick(); assert.deepEqual(s.calls,[true,false]);
  s.emit({type:'wake'}); assert.equal(s.voice.state,'idle');
  s.voice.setContext(true,false); await tick(); assert.deepEqual(s.calls,[true,false,true]);
  await s.voice.dispose(); assert.deepEqual(s.calls,[true,false,true,false]);
});

test('wake clips have a distinct source, rearm only after completion, and silence delivers nothing', async () => {
  const s=setup(); await s.voice.setEnabled(true); await tick();
  s.emit({type:'wake'}); assert.equal(s.voice.state,'recording'); assert.equal(s.voice.source,'wake');
  s.emit({type:'clip',seconds:6}); assert.deepEqual(s.clips,[]); assert.equal(s.voice.state,'idle');
  s.emit({type:'wake'}); s.emit({type:'clip',seconds:2,wav:new Uint8Array(48)});
  assert.deepEqual(s.clips,['wake']); assert.equal(s.detectorCalls.filter(x=>x==='listen').length,3);
  assert.deepEqual(s.calls,[true]); await s.voice.dispose();
});

test('hold takes over an utterance and remains usable if wake activation is switched off', async () => {
  const s=setup(); await s.voice.setEnabled(true); await tick(); s.emit({type:'wake'});
  await s.voice.start(); assert.equal(s.voice.source,'manual'); assert.ok(s.detectorCalls.includes('hold'));
  await s.voice.setEnabled(false); assert.equal(s.voice.state,'recording');
  await s.voice.stop(); await tick(); assert.deepEqual(s.clips,['manual']); assert.equal(s.voice.state,'idle');
  assert.deepEqual(s.calls,[true,false]); await s.voice.dispose();
});

test('manual capture reuses a listening microphone and wake listening resumes after release', async () => {
  const s=setup(); await s.voice.setEnabled(true); await tick();
  await s.voice.start(); assert.deepEqual(s.calls,[true]);
  s.voice.append(new Uint8Array([1,0])); await s.voice.stop(); await tick();
  assert.deepEqual(s.clips,['manual']); assert.deepEqual(s.calls,[true,false,true]);
  await s.voice.dispose(); assert.deepEqual(s.calls,[true,false,true,false]);
});

test('context loss cancels an automatic utterance and rejects a late result', async () => {
  const s=setup(); await s.voice.setEnabled(true); await tick(); s.emit({type:'wake'});
  s.voice.setContext(false,false); await tick(); s.emit({type:'clip',seconds:1,wav:new Uint8Array(48)});
  assert.deepEqual(s.clips,[]); assert.deepEqual(s.calls,[true,false]); await s.voice.dispose();
});

test('microphone close failure remains visible and retryable after wake OFF', async () => {
  const s=setup(); await s.voice.setEnabled(true); await tick(); s.close(false);
  await s.voice.setEnabled(false); assert.equal(s.voice.state,'stop-error');
  s.close(true); await s.voice.stop(); assert.equal(s.voice.state,'idle');
  assert.deepEqual(s.calls,[true,false,false]); await s.voice.dispose();
});

test('stalled audio and detector faults fail closed but manual input remains available', async () => {
  const s=setup(); await s.voice.setEnabled(true); await tick(); s.clock(6000);
  s.voice.append(new Uint8Array([0,0])); await tick();
  assert.ok(s.states.includes('wake:error')); assert.deepEqual(s.calls,[true,false]);
  await s.voice.start(); s.voice.append(new Uint8Array([1,0])); await s.voice.stop(true);
  assert.equal(s.voice.state,'idle'); await s.voice.dispose();
});

test('turning OFF while models load disposes the result without opening the mic', async () => {
  let resolve!: (detector: WakeDetector) => void, disposed=0;
  const voice = new VoiceInput({microphone:async()=>assert.fail('Must not open'), loadWake:()=>new Promise(r=>{resolve=r;}),onClip:()=>{},onState:()=>{},onError:()=>{},onWakeState:()=>{}});
  voice.setContext(true,false); const loading=voice.setEnabled(true); await voice.setEnabled(false);
  resolve({listen:()=>assert.fail(),cancel:()=>{},hold:()=>{},finish:()=>{},append:()=>{},dispose:()=>{disposed++;}});
  await loading; assert.equal(disposed,1); await voice.dispose();
});

test('a transient relay failure preserves a manual hold until release, even with wake OFF', async () => {
  const s=setup();await s.voice.start();s.voice.append(new Uint8Array([1,0]));
  s.voice.setContext(false,false,true);await tick();assert.equal(s.voice.state,'recording');
  s.voice.append(new Uint8Array([2,0]));await s.voice.stop();assert.deepEqual(s.clips,['manual']);
  await s.voice.dispose();
});

test('an active wake utterance survives a poll failure, then pauses until connectivity returns', async () => {
  const s=setup();await s.voice.setEnabled(true);await tick();s.emit({type:'wake'});
  s.voice.setContext(false,false,true);await tick();assert.equal(s.voice.state,'recording');
  s.emit({type:'clip',seconds:2,wav:new Uint8Array(48)});await tick();assert.deepEqual(s.clips,['wake']);
  assert.deepEqual(s.calls,[true,false]);s.voice.setContext(true,false,true);await tick();
  assert.deepEqual(s.calls,[true,false,true]);await s.voice.dispose();
});
