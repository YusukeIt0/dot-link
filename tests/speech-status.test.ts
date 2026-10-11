import test from 'node:test';
import assert from 'node:assert/strict';
import { readSTTProvider, speechDevice, speechStatus } from '../src/speech-status.ts';

test('speech labels show verified provider and the actual client TTS device without inventing a model', () => {
  assert.equal(speechStatus('soniox', true, true, true, 'iPhone'), 'STT:Soniox / TTS:iPhone');
  assert.equal(speechStatus('whisper', true, true, true, 'Mac'), 'STT:Whisper / TTS:Mac');
  assert.equal(speechStatus('soniox', true, false, true, 'iPhone'), 'STT:Soniox / TTS:OFF');
  assert.equal(speechStatus('soniox', false, true, true, 'iPhone'), 'STT:— / TTS:iPhone');
  assert.equal(speechStatus(undefined, true, true, false, 'iPhone'), 'STT:— / TTS:—');
  assert.equal(readSTTProvider('soniox'), 'soniox');
  assert.equal(readSTTProvider('unknown'), undefined);
  assert.equal(speechDevice('Mozilla iPhone OS'), 'iPhone');
  assert.equal(speechDevice('Mozilla Macintosh', 5), 'iPhone');
  assert.equal(speechDevice('Mozilla Macintosh', 0), 'Mac');
  assert.equal(speechDevice('Mozilla Android'), 'Device');
});
