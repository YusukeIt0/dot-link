import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PcmRecording } from '../src/audio.ts';
import { hasSpeech } from '../server/speech-presence.ts';
import { selectableTranscriber } from '../server/stt.ts';
import { STT_PROVIDERS, type STTProvider } from '../src/stt-providers.ts';

function noise(kind: string, seconds = 5): Buffer {
  let seed = 213;
  const pcm = new Int16Array(16000 * seconds);
  for (let i = 0; i < pcm.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pcm[i] = kind === 'white' ? (seed / 4294967296 * 2 - 1) * 1000 :
      kind === 'hum' ? Math.sin(i * 2 * Math.PI * 60 / 16000) * 1000 :
      kind === 'tone' ? Math.sin(i * 2 * Math.PI * 440 / 16000) * 3000 :
      kind === 'click' ? (i % 16000 < 20 ? 12000 : 0) : kind === 'dc' ? 1000 : 0;
  }
  const recording = new PcmRecording(); recording.append(new Uint8Array(pcm.buffer));
  return Buffer.from(recording.toWav());
}
for (const kind of ['zero', 'white', 'hum', 'tone', 'click', 'dc']) test(`real offline detector rejects ${kind} without selecting a provider`, async () => {
  const wav = noise(kind), original = Buffer.from(wav);
  const fail = async () => assert.fail('No-speech recording reached provider selection or transcription');
  const run = selectableTranscriber({ selection: fail, whisper: fail, soniox: fail });
  assert.equal(await run(wav), '');
  assert.deepEqual(wav, original);
});

test('each provider is gated before credentials or audio delivery', async () => {
  for (const provider of Object.keys(STT_PROVIDERS) as STTProvider[]) {
    let detected = false, calls = 0;
    const wav = noise('white');
    const transcribe = async (received: Buffer) => { assert.equal(received, wav); calls++; return 'Speech'; };
    const run = selectableTranscriber({ selection: async () => provider, speech: async () => detected,
      whisper: transcribe, soniox: transcribe, providers: Object.fromEntries(Object.keys(STT_PROVIDERS).map(p => [p, transcribe])) });
    assert.equal(await run(wav), ''); assert.equal(calls, 0);
    detected = true;
    assert.equal(await run(wav), 'Speech'); assert.equal(calls, 1);
  }
});

test('detector failure/cancellation never falls through, and the next recording can retry', async () => {
  let attempts = 0;
  const fail = async () => assert.fail('Must not reach STT');
  const run = selectableTranscriber({ selection: fail, whisper: fail, soniox: fail,
    speech: async () => { if (!attempts++) throw new Error('Private vendor detail'); return false; } });
  await assert.rejects(run(noise('white')), { message: 'STT_UNAVAILABLE' });
  assert.equal(await run(noise('white')), '');
  const controller = new AbortController();
  const cancelled = selectableTranscriber({ selection: fail, whisper: fail, soniox: fail,
    speech: async () => { controller.abort(); return true; } });
  await assert.rejects(cancelled(noise('white'), controller.signal), { message: 'STT_CANCELLED' });
  const active = new AbortController();
  const pending = hasSpeech(noise('white', 30), active.signal);
  active.abort(); await assert.rejects(pending, /cancelled/);
});

const base = new URL('./fixtures/speech/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8')) as Array<{file: string; locale: string; kind: string}>;
for (const sample of manifest) test(`real detector preserves ${sample.file} at original and low volume`, async () => {
  const original = await readFile(new URL(sample.file, base));
  for (const gain of [1, 0.1, 0.01]) {
    const wav = Buffer.from(original);
    for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(wav.readInt16LE(i) * gain), i);
    const before = Buffer.from(wav);
    assert.equal(await hasSpeech(wav), true, `${sample.file}, gain=${gain}`);
    assert.deepEqual(wav, before, 'Detection must not change the recording sent to STT');
  }
});

test('noise remains rejected across duration and level, including 30-second holds', async () => {
  for (const kind of ['zero', 'white', 'hum', 'tone', 'click', 'dc']) {
    for (const seconds of [0.1, 0.5, 30]) {
      const wav = noise(kind, seconds);
      for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(wav.readInt16LE(i) * 0.01), i);
      assert.equal(await hasSpeech(wav), false, `${kind}, ${seconds}s at 1% amplitude`);
    }
  }
});

test('speech surrounded by silence and modest background noise survives without waveform changes', async () => {
  for (const sample of manifest.filter(s => s.kind === 'sentence')) {
    const original = await readFile(new URL(sample.file, base));
    const recording = new PcmRecording();
    recording.append(new Uint8Array(16000 * 2 * 10));
    const pcm = Buffer.from(original.subarray(44));
    let seed = 213;
    for (let i = 0; i < pcm.length; i += 2) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pcm.writeInt16LE(Math.round(pcm.readInt16LE(i) * 0.1 + (seed / 4294967296 * 2 - 1) * 20), i);
    }
    recording.append(pcm); recording.append(new Uint8Array(16000 * 2 * 10));
    assert.equal(await hasSpeech(Buffer.from(recording.toWav())), true, sample.locale);
  }
});
