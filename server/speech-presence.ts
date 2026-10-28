import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';

/** Offline, per-recording worker: no audio files, remote model fetch or retained state. */
export function hasSpeech(wav: Buffer, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Speech detection cancelled')); return; }
    // Packaged apps include dist; source checkouts use the verified public assets.
    const assets = new URL('../dist/wake-assets/', import.meta.url);
    const sourceAssets = new URL('../public/wake-assets/', import.meta.url);
    const base = existsSync(new URL('runtime.js', assets)) ? assets : sourceAssets;
    const worker = new Worker(new URL('./speech-worker.ts', import.meta.url), {
      workerData: { wav: Uint8Array.from(wav), assets: base.href }, stdout: true, stderr: true,
    });
    let settled = false;
    const finish = (error?: Error, result?: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      void worker.terminate().finally(() => error ? reject(error) : resolve(result!));
    };
    const cancel = () => finish(new Error('Speech detection cancelled'));
    const timer = setTimeout(() => finish(new Error('Speech detection timed out')), 15_000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.once('message', result => typeof result === 'boolean' ? finish(undefined, result) : finish(new Error('Invalid speech detection result')));
    worker.once('error', () => finish(new Error('Speech detection unavailable')));
    worker.once('exit', () => { if (!settled) finish(new Error('Speech detection stopped')); });
    // Drain vendor diagnostics without recording audio or exposing internals.
    worker.stdout.resume(); worker.stderr.resume();
    if (signal?.aborted) cancel();
  });
}
