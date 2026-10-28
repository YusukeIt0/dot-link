import type { WakeEvent, SpeakerRole } from './wake-engine.ts';
import { validateWakeName } from './wake-name.ts';

export interface WakeDetector {
  listen(): void;
  cancel(): void;
  hold(): void;
  finish(discard: boolean): void;
  append(pcm: Uint8Array, role?: SpeakerRole): void;
  dispose(): void;
}
export type LoadWakeDetector = (event: (event: WakeEvent) => void, error: () => void, name?: string) => Promise<WakeDetector>;

/** Audio never enters a network API. The worker and its models are packaged assets. */
export const loadWakeDetector: LoadWakeDetector = (event, error, name = 'dot') => new Promise((resolve, reject) => {
  if (validateWakeName(name).error) { reject(new Error('Invalid wake name')); return; }
  const worker = new Worker(new URL('./wake-worker.ts', import.meta.url), { type: 'module' });
  let ready = false, disposed = false, generation = 0, pendingBytes = 0;
  const timer = setTimeout(() => fail(), 30_000);
  function dispose(): void { disposed = true; clearTimeout(timer); worker.terminate(); pendingBytes = 0; }
  function fail(): void {
    if (disposed) return;
    dispose();
    if (ready) error(); else reject(new Error('Wake input unavailable'));
  }
  const send = (type: string, extra = {}) => { if (!disposed) worker.postMessage({ type, generation, ...extra }); };
  const detector: WakeDetector = {
    listen() { generation++; pendingBytes = 0; send('listen'); },
    cancel() { generation++; pendingBytes = 0; send('cancel'); },
    hold() { send('hold'); },
    finish(discard) { send('finish', { discard }); },
    append(pcm, role = 'unknown') {
      if (disposed) return;
      // A suspended or overloaded worker must not build an unbounded audio queue.
      if (pcm.length % 2 || pcm.length > 32_000 || pendingBytes + pcm.length > 48_000) { fail(); return; }
      const copy = pcm.slice(); pendingBytes += copy.length;
      worker.postMessage({ type: 'audio', generation, pcm: copy, role }, [copy.buffer]);
    },
    dispose,
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  worker.onmessage = ({ data }) => {
    if (disposed) return;
    if (data.type === 'error') { fail(); return; }
    if (data.type === 'ready') { ready = true; clearTimeout(timer); resolve(detector); return; }
    if (!ready || data.generation !== generation) return;
    if (data.type === 'processed') { pendingBytes = Math.max(0, pendingBytes - data.bytes); return; }
    if (data.type === 'wake') event({ type: 'wake' });
    if (data.type === 'clip') event({ type: 'clip', wav: data.wav, seconds: data.seconds });
  };
  send('init', { assets: new URL('wake-assets/', document.baseURI).href, name });
});
