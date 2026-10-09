import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmRecording, Recorder } from '../src/audio.ts';

test('failed microphone close remains retryable and prevents a new recording', async () => {
  const calls: boolean[] = [];
  const errors: string[] = [];
  let closeSucceeds = false;
  const recorder = new Recorder(async on => {
    calls.push(on); return on || closeSucceeds;
  }, () => assert.fail('Failed close must not deliver audio'), () => {}, message => errors.push(message));
  await recorder.start();
  recorder.append(new Uint8Array([2, 0]));
  await recorder.stop();
  assert.equal(recorder.state, 'stop-error');
  await recorder.start();
  assert.deepEqual(calls, [true, false]);
  assert.equal(errors.length, 1);
  closeSucceeds = true;
  await recorder.stop();
  assert.equal(recorder.state, 'idle');
  assert.deepEqual(calls, [true, false, false]);
});

test('PCM is copied, bounded, and encoded as valid mono 16 kHz WAV', () => {
  const pcm = new PcmRecording(2 / 16000);
  const input = new Uint8Array([1, 2, 3, 4, 5, 6]);
  assert.equal(pcm.append(input), false);
  input.fill(0);
  const wav = pcm.toWav();
  const view = new DataView(wav.buffer);
  assert.equal(wav.length, 48);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), 40);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 4);
  assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4]);
  assert.equal(pcm.append(new Uint8Array([7, 8])), false);
  pcm.clear(); assert.equal(pcm.byteLength, 0);
});

test('release while microphone is opening still closes it and never retains later frames', async () => {
  let open!: (value: boolean) => void;
  const calls: boolean[] = [];
  const clips: Uint8Array[] = [];
  const recorder = new Recorder(on => {
    calls.push(on);
    return on ? new Promise(resolve => { open = resolve; }) : Promise.resolve(true);
  }, clip => clips.push(clip), () => {}, message => assert.fail(message));
  const starting = recorder.start();
  await Promise.resolve();
  const stopping = recorder.stop();
  recorder.append(new Uint8Array([1, 0]));
  open(true);
  await Promise.all([starting, stopping]);
  assert.deepEqual(calls, [true, false]);
  assert.equal(recorder.state, 'idle');
  assert.equal(clips.length, 0);
});

test('discard closes microphone without delivering a recording', async () => {
  const calls: boolean[] = [];
  let delivered = false;
  const recorder = new Recorder(async on => { calls.push(on); return true; },
    () => { delivered = true; }, () => {}, message => assert.fail(message));
  await recorder.start();
  recorder.append(new Uint8Array([2, 0]));
  await recorder.stop(true);
  assert.deepEqual(calls, [true, false]);
  assert.equal(delivered, false);
});
