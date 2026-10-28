import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { speechActivityConfig, recordingHasSpeech } from '../src/speech-activity.ts';

// The pinned Emscripten modules expect CommonJS globals in Node. Keep that
// compatibility environment isolated from the relay and all other requests.
const host = globalThis as unknown as Record<string, unknown>;
const base = new URL(workerData.assets);
host.module = { exports: {} };
host.require = createRequire(import.meta.url);
host.__dirname = fileURLToPath(base);
const wav = workerData.wav as Uint8Array;
try {
  const [{ default: createRuntime }, { default: api }] = await Promise.all([
    import(new URL('runtime.js', base).href), import(new URL('vad.js', base).href),
  ]);
  const runtime = await createRuntime({ locateFile: (name: string) => fileURLToPath(new URL(name, base)),
    print: () => {}, printErr: () => {} });
  runtime.FS.writeFile('/silero_vad.onnx', await readFile(new URL('silero_vad.onnx', base)));
  const detector = api.createVad(runtime, speechActivityConfig('/silero_vad.onnx', 'presence'));
  if (!detector.handle) throw new Error('Detector unavailable');
  try { parentPort!.postMessage(recordingHasSpeech(wav, detector)); }
  finally { detector.free(); }
} finally { wav.fill(0); }
