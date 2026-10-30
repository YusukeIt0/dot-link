import { distanceMeters } from '../../src/location-fix.ts';
import { MobilityNetwork } from './network.ts';
import { decodeTerrarium } from './terrarium.ts';

export interface Point { latitude: number; longitude: number; }
export const terrainLimitations = [
  'Model terrain, not measured route, building, bridge or tunnel height. Survey age and vertical accuracy are unknown.',
  'Raster resolution and smoothing can miss short steep sections. Estimates do not establish access or safety.',
  'Surface objects and raster noise can inflate ascent and peak grade; do not describe a sampled maximum as a verified steep street.',
];
export function validPoint(p: Point) {
  return Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
}
function pixel(p: Point) {
  if (!validPoint(p) || Math.abs(p.latitude) > 85) return undefined;
  const sin = Math.sin(p.latitude * Math.PI / 180);
  return {x: ((p.longitude + 180) / 360 * 1048576) % 1048576,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 1048576};
}
function interpolate(a: Point, b: Point, f: number): Point {
  const delta = ((b.longitude - a.longitude + 540) % 360) - 180;
  return {latitude: a.latitude + (b.latitude - a.latitude) * f, longitude: ((a.longitude + delta * f + 540) % 360) - 180};
}
export function samplePath(path: Point[]): {points: Point[]; distances: number[]; spacing: number} {
  if (path.length < 2 || path.length > 10_000 || path.some(p => !validPoint(p))) throw new Error('Invalid walking geometry');
  const cumulative = [0];
  for (let i = 1; i < path.length; i++) cumulative.push(cumulative[i - 1]! + distanceMeters(path[i - 1]!, path[i]!));
  const total = cumulative.at(-1)!;
  if (!Number.isFinite(total) || total > 100_000) throw new Error('Walking geometry exceeds terrain bounds');
  const count = Math.max(1, Math.min(256, Math.ceil(total / 50))), spacing = total / count;
  const points: Point[] = [], distances: number[] = []; let segment = 1;
  for (let i = 0; i <= count; i++) {
    const distance = i * spacing;
    while (segment < path.length - 1 && cumulative[segment]! < distance) segment++;
    const length = cumulative[segment]! - cumulative[segment - 1]!;
    points.push(interpolate(path[segment - 1]!, path[segment]!, length ? (distance - cumulative[segment - 1]!) / length : 0));
    distances.push(distance);
  }
  return {points, distances, spacing};
}

/** No coordinate history/disk writes. Cached public rasters are bounded to 16 tiles. */
export class TerrainProvider {
  private cache = new Map<string, {height: Float32Array; expires: number}>();
  private readonly network: MobilityNetwork;
  private readonly now: () => number;
  constructor(network: MobilityNetwork, now = Date.now) { this.network = network; this.now = now; }
  clear() { this.cache.clear(); }
  async elevations(points: Point[], signal: AbortSignal) {
    if (points.length > 257 || points.some(p => !validPoint(p))) throw new Error('Invalid terrain sample');
    const tiles = new Map<string, Float32Array | undefined>();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const values: (number | null)[] = [];
    for (const point of points) {
      signal.throwIfAborted();
      const p = pixel(point);
      if (!p) { values.push(null); continue; }
      const tileX = Math.floor(p.x / 256), tileY = Math.floor(p.y / 256), key = `${tileX}/${tileY}`;
      if (!tiles.has(key)) {
        if (tiles.size >= 12 || bounded.aborted) {values.push(null); continue;}
        let cached = this.cache.get(key);
        if (cached && cached.expires <= this.now()) {this.cache.delete(key); cached = undefined;}
        let height = cached?.height;
        if (!height) {
          try {
            const bytes = await this.network.bytes(new URL(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/${key}.png`), bounded, 512 * 1024);
            signal.throwIfAborted(); height = decodeTerrarium(bytes);
            this.cache.set(key, {height, expires: this.now() + 3_600_000});
            while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
          } catch { signal.throwIfAborted(); }
        }
        tiles.set(key, height);
      }
      const tile = tiles.get(key);
      if (!tile) {values.push(null); continue;}
      // Bilinear interpolation within a tile; edge pixels are clamped, not fetched unboundedly.
      const x = Math.min(255, Math.max(0, p.x - tileX * 256 - 0.5)), y = Math.min(255, Math.max(0, p.y - tileY * 256 - 0.5));
      const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
      const corners = [tile[y0 * 256 + x0]!, tile[y0 * 256 + x1]!, tile[y1 * 256 + x0]!, tile[y1 * 256 + x1]!];
      const fx = x - x0, fy = y - y0;
      values.push(corners.every(Number.isFinite) ? (corners[0]! * (1 - fx) + corners[1]! * fx) * (1 - fy) + (corners[2]! * (1 - fx) + corners[3]! * fx) * fy : null);
    }
    signal.throwIfAborted();
    return values;
  }
  async profile(path: Point[], signal: AbortSignal) {
    const samples = samplePath(path), values = await this.elevations(samples.points, signal);
    let ascent = 0, descent = 0, covered = 0, maximumGrade = 0;
    for (let i = 1; i < values.length; i++) {
      const before = values[i - 1], after = values[i];
      if (before == null || after == null || samples.spacing === 0) continue;
      covered++; const delta = after - before;
      ascent += Math.max(0, delta); descent += Math.max(0, -delta);
      maximumGrade = Math.max(maximumGrade, Math.abs(delta) / samples.spacing * 100);
    }
    const complete = values.every(v => v !== null), round = (v: number) => Math.round(v);
    return {status: complete ? 'available' : covered ? 'partial' : 'unavailable',
      source: 'Mapzen Terrain Tiles', model: 'Terrarium', confidence: 'unvalidated_model_estimate', zoom: 12,
      attribution_url: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
      sampled_at: new Date(this.now()).toISOString(), sample_count: values.length,
      sample_spacing_m: Math.round(samples.spacing * 10) / 10,
      raster_spacing_m_at_start: Math.round(40075017 * Math.cos(path[0]!.latitude * Math.PI / 180) / 1048576),
      covered_segments: covered, total_segments: values.length - 1,
      origin_elevation_m: values[0] == null ? null : round(values[0]),
      destination_elevation_m: values.at(-1) == null ? null : round(values.at(-1)!),
      ascent_m: complete ? round(ascent) : null, descent_m: complete ? round(descent) : null,
      maximum_sampled_grade_percent: complete ? Math.round(maximumGrade * 10) / 10 : null,
      limitations: [...terrainLimitations, ...(!complete ? ['Missing samples; complete-route ascent, descent and grade are unknown.'] : [])]};
  }
}
