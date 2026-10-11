import test from 'node:test';
import assert from 'node:assert/strict';
import { readSTTProvider, speechDevice, speechStatus } from '../src/speech-status.ts';

test('speech labels show verified provider and the actual client TTS device without inventing a model', () => {
  assert.equal(speechStatus('soniox', true, true, true, 'iPhone'), 'STT:Soniox stt-rt-v5 / TTS:iPhone');
  assert.equal(speechStatus('whisper', true, true, true, 'Mac'), 'STT:Whisper small / TTS:Mac');
  assert.equal(speechStatus('soniox', true, false, true, 'iPhone'), 'STT:Soniox stt-rt-v5 / TTS:OFF');
  assert.equal(speechStatus('soniox', false, true, true, 'iPhone'), 'STT:— / TTS:iPhone');
  assert.equal(speechStatus(undefined, true, true, false, 'iPhone'), 'STT:— / TTS:—');
  assert.equal(readSTTProvider('soniox'), 'soniox');
  assert.equal(readSTTProvider('unknown'), undefined);
  assert.equal(speechDevice('Mozilla iPhone OS'), 'iPhone');
  assert.equal(speechDevice('Mozilla Macintosh', 5), 'iPhone');
  assert.equal(speechDevice('Mozilla Macintosh', 0), 'Mac');
  assert.equal(speechDevice('Mozilla Android'), 'Device');
});


test('new providers show their model, and actual relay model wins over bundled defaults', () => {
  const labels = {elevenlabs:'ElevenLabs scribe_v2',microsoft:'Microsoft MAI-Transcribe-2',openai:'OpenAI gpt-transcribe',assemblyai:'AssemblyAI universal-3-5-pro'};
  for (const [id,label] of Object.entries(labels)) {
    const provider=readSTTProvider(id); assert.ok(provider);
    assert.equal(speechStatus(provider,true,true,true,'iPhone'),`STT:${label} / TTS:iPhone`);
    assert.equal(speechStatus(provider,false,true,true,'iPhone'),'STT:— / TTS:iPhone');
  }
  assert.equal(speechStatus('soniox',true,false,true,'iPhone','stt-rt-future'),'STT:Soniox stt-rt-future / TTS:OFF');
  assert.equal(readSTTProvider('__proto__'),undefined);
});
