import { summarizeRainRate } from '../../server/weather/rain-rate/raster.ts';
import type { NearbyRainRead } from '../../server/weather/rain-rate/service.ts';
import type { WeatherPoint } from '../../server/weather/types.ts';

export function rainFrame(point: WeatherPoint, start: number, requested: number, retrieved: number, revision: number): NearbyRainRead {
  const iso = (n: number) => new Date(n).toISOString();
  const end = start + 599_900, created = end + 100_100;
  const stamp = (n: number) => iso(n).replace(/[-:T.Z]/g, '').slice(0, 15);
  const key = 'BLEND/RainRate-Blend-INST/' + iso(start).slice(0, 13).replace(/[-T]/g, '/') +
    '/RRQPE-INST-GLB-1_v1r1_blend_s' + stamp(start) + '_e' + stamp(end) + '_c' + stamp(created) + '.nc';
  const sample = summarizeRainRate(point, {coverage_start: iso(start), coverage_end: iso(start + 9 * 60_000), created: iso(created),
    sensors: ['ABI-g19'], missing_inputs: 4, pixel_observed_at: null}, (r0, r1, c0, c1) => {
    const count = (r1-r0) * (c1-c0);
    return {rain: new Int16Array(count).fill(12), quality: new Int8Array(count)};
  });
  return {sample, frame: {key, inputs:1, start, end, created, published:created + 1000, requested, retrieved,
    etag:'"' + String(revision).repeat(32) + '"', checksum:'AAAAAA==', size:1024}};
}
