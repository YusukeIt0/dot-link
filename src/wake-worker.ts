import { speechActivityConfig } from './speech-activity.ts';
import { WakeEngine, type KeywordSpotter, type SpeechDetector } from './wake-engine.ts';
import { validateWakeName, wakeNameTokens, type WakeVocabulary } from './wake-name.ts';

interface Runtime {
  FS: { writeFile(path: string, data: Uint8Array | string): void; unlink(path: string): void };
}
interface WorkerRuntime {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  SherpaOnnx(options: { locateFile: (file: string) => string; print: () => void; printErr: () => void }): Promise<Runtime>;
  DotKws: { createKws(module: Runtime, config: object): KeywordSpotter & { handle: number } };
  DotVad: { createVad(module: Runtime, config: object): SpeechDetector & { handle: number } };
}
const host = globalThis as unknown as WorkerRuntime;
let engine: WakeEngine | undefined;
let generation = 0;
let initialized = false;

async function initialize(assets: string, name = 'dot'): Promise<void> {
  if (validateWakeName(name).error) throw new Error('Invalid wake name');
  if (initialized) throw new Error('Already initialized');
  initialized = true;
  const base = new URL(assets);
  const asset = (name: string) => new URL(name, base).href;
  const [runtime, keyword, activity] = await Promise.all(['runtime.js', 'kws.js', 'vad.js'].map(
    name => import(/* @vite-ignore */ asset(name))));
  const createRuntime = runtime.default as WorkerRuntime['SherpaOnnx'];
  const kwsApi = keyword.default as WorkerRuntime['DotKws'];
  const vadApi = activity.default as WorkerRuntime['DotVad'];
  const module = await createRuntime({ locateFile: asset, print: () => {}, printErr: () => {} });
  const names = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt', 'silero_vad.onnx'];
  await Promise.all(names.map(async name => {
    const response = await fetch(asset(name));
    if (!response.ok) throw new Error('Model unavailable');
    module.FS.writeFile(`/${name}`, new Uint8Array(await response.arrayBuffer()));
  }));
  const response = await fetch(asset('name-vocabulary.json'));
  if (!response.ok) throw new Error('Vocabulary unavailable');
  const vocabulary = await response.json() as WakeVocabulary;
  // HEY_DOT is an internal event tag, not the user's phrase. Keep one keyword
  // only: a custom name replaces the default rather than adding a second cue.
  module.FS.writeFile('/keywords.txt', `${wakeNameTokens(name, vocabulary).join(' ')} @HEY_DOT\n`);
  const kws = kwsApi.createKws(module, {
    featConfig: { samplingRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: '/encoder.onnx', decoder: '/decoder.onnx', joiner: '/joiner.onnx' },
      tokens: '/tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelType: 'zipformer2', modelingUnit: 'bpe', bpeVocab: '' },
    maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 3, keywordsThreshold: 0.1, keywords: '/keywords.txt',
  });
  const vad = vadApi.createVad(module, speechActivityConfig('/silero_vad.onnx'));
  if (!kws.handle || !vad.handle) throw new Error('Detector unavailable');
  // Sessions own the model data now; don't keep a second copy in the virtual FS.
  for (const name of names) module.FS.unlink(`/${name}`);
  module.FS.unlink('/keywords.txt');
  engine = new WakeEngine(kws, vad, event => {
    const message = { ...event, generation };
    host.postMessage(message, event.type === 'clip' && event.wav ? [event.wav.buffer as ArrayBuffer] : []);
  });
  host.postMessage({ type: 'ready' });
}

globalThis.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') { await initialize(data.assets, data.name); return; }
    if (!engine) return;
    if (data.type === 'listen' || data.type === 'cancel') {
      generation = data.generation;
      if (data.type === 'listen') engine.listen(); else engine.cancel();
      return;
    }
    if (data.generation !== generation) return;
    if (data.type === 'hold') engine.hold();
    if (data.type === 'finish') engine.finish(data.discard === true);
    if (data.type === 'audio') {
      engine.append(data.pcm);
      host.postMessage({ type: 'processed', generation, bytes: data.pcm.length });
    }
  } catch {
    engine?.dispose(); engine = undefined;
    host.postMessage({ type: 'error' });
  }
};
