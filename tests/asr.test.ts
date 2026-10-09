import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmRecording } from '../src/audio.ts';
import { validateWav } from '../server/asr.ts';

test('only bounded non-silent G2 PCM WAV reaches the transcription process', () => {
  const recording = new PcmRecording();
  const pcm = new Int16Array(8000).fill(1000);
  recording.append(new Uint8Array(pcm.buffer));
  const wav = Buffer.from(recording.toWav());
  assert.doesNotThrow(() => validateWav(wav));
  const wrongRate = Buffer.from(wav); wrongRate.writeUInt32LE(48000, 24);
  assert.throws(() => validateWav(wrongRate));
  assert.throws(() => validateWav(wav.subarray(0, 400)));
  assert.throws(() => validateWav(Buffer.alloc(960046)));
  const silent = Buffer.from(wav); silent.fill(0, 44);
  assert.throws(() => validateWav(silent), /silent/);
});
