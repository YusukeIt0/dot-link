import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WeatherPoint } from '../types.ts';
import type { RainRateFrame } from './discovery.ts';
import { sampleSchema, type RainRateSample } from './raster.ts';

export { compareRainRateSamples, inRainRateExtent, type RainRateSample } from './raster.ts';
export type CheckedRainRateFrame = RainRateFrame & {checksum: string};

let active = false;
const unavailable = () => new Error('Satellite precipitation decoder unavailable');

/** The child gets the location through stdin, has no network task, and owns the entire HDF5 runtime. */
export async function decodeRainRate(framePath: string, edition: CheckedRainRateFrame, point: WeatherPoint, signal: AbortSignal): Promise<RainRateSample> {
  signal.throwIfAborted();
  if (active) throw unavailable();
  active = true;
  try {
    return await new Promise<RainRateSample>((resolve, reject) => {
      const args = ['--wasm-max-mem-pages=1024', '--max-old-space-size=64',
        fileURLToPath(new URL('./decoder-process.ts', import.meta.url))];
      const child = execFile(process.execPath, args, {timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 32_768, env: {}}, (error, stdout) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { reject(signal.reason); return; }
        if (error) { reject(unavailable()); return; }
        try { resolve(sampleSchema.parse(JSON.parse(stdout))); }
        catch { reject(unavailable()); }
      });
      // Keep the process limit reserved until the child actually exits, including after cancellation.
      const abort = () => { child.kill('SIGKILL'); };
      signal.addEventListener('abort', abort, {once: true});
      child.stdin?.on('error', abort);
      child.stdin?.end(JSON.stringify({framePath, edition, point}));
      if (signal.aborted) abort();
    });
  } finally { active = false; }
}
