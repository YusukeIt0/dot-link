import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WeatherPoint } from '../types.ts';
import type { RainRateFrame } from './discovery.ts';
import { sampleSchema, type RainRateSample } from './raster.ts';

export { compareRainRateSamples, inRainRateExtent, type RainRateSample } from './raster.ts';
export type CheckedRainRateFrame = RainRateFrame & {checksum: string};

let active = false;
let waitingProbe: (() => void) | undefined;
const unavailable = () => new Error('Satellite precipitation decoder unavailable');

/** The child gets the location through stdin, has no network task, and owns the entire HDF5 runtime. */
async function runDecoder(framePath: string, edition: CheckedRainRateFrame, point: WeatherPoint, signal: AbortSignal, waitForSlot = false): Promise<RainRateSample | null> {
  signal.throwIfAborted();
  if (active) {
    if (!waitForSlot || waitingProbe) throw unavailable();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { waitingProbe = undefined; reject(signal.reason); };
      waitingProbe = () => {
        signal.removeEventListener('abort', abort);
        waitingProbe = undefined;
        resolve();
      };
      signal.addEventListener('abort', abort, {once: true});
    });
  } else { active = true; }
  try {
    signal.throwIfAborted();
    return await new Promise<RainRateSample | null>((resolve, reject) => {
      const args = ['--wasm-max-mem-pages=1024', '--max-old-space-size=64',
        fileURLToPath(new URL('./decoder-process.ts', import.meta.url))];
      const child = execFile(process.execPath, args, {timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 32_768, env: {}}, (error, stdout) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { reject(signal.reason); return; }
        if (error) { reject(unavailable()); return; }
        try {
          const output: unknown = JSON.parse(stdout);
          resolve(output === null ? null : sampleSchema.parse(output));
        }
        catch { reject(unavailable()); }
      });
      // Keep the process limit reserved until the child actually exits, including after cancellation.
      const abort = () => { child.kill('SIGKILL'); };
      signal.addEventListener('abort', abort, {once: true});
      child.stdin?.on('error', abort);
      child.stdin?.end(JSON.stringify({framePath, edition, point}));
      if (signal.aborted) abort();
    });
  } finally {
    // Transfer ownership before the completed read can request another frame.
    // The slot stays active throughout handoff, including after a failed read.
    if (waitingProbe) waitingProbe();
    else active = false;
  }
}

export async function decodeRainRate(framePath: string, edition: CheckedRainRateFrame, point: WeatherPoint, signal: AbortSignal): Promise<RainRateSample> {
  const sample = await runDecoder(framePath, edition, point, signal);
  if (!sample) throw unavailable();
  return sample;
}

/** Validate an edition before promotion by decoding both variables around a fixed public city.
 * Missing or degraded rain at this location is a permissible result for a partial satellite mosaic. */
export async function probeRainRateFrame(framePath: string, edition: CheckedRainRateFrame, signal: AbortSignal): Promise<'supported' | 'unsupported'> {
  const sample = await runDecoder(framePath, edition, {latitude: 13.7563, longitude: 100.5018}, signal, true);
  return sample ? 'supported' : 'unsupported';
}
