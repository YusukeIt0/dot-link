import { createHash } from 'node:crypto';
import { z } from 'zod';
import { weatherPointSchema, type WeatherPoint } from '../types.ts';

export const GRID = { rows: 6501, cols: 18000, north: 70, south: -60, west: -180, step: 0.02 };
const EARTH_KM = 6371.0088;
const TO_RAD = Math.PI / 180;
const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
const areaNames = ['within_5_km', ...directions] as const;
const source = {
  provider: 'NOAA/NESDIS Enterprise Rain Rate', data_kind: 'satellite_precipitation_rate_estimate',
  transformation: 'Dot Link summary of NOAA grid cells', rate_unit: 'mm/h', grid_spacing_degrees: 0.02,
  inner_radius_km: 5, outer_radius_km: 20,
} as const;
const cellCount = z.number().int().min(0).max(2048);
const areaSchema = z.object({
  area: z.enum(areaNames), cells: cellCount, nominal: cellCount, wet_nominal: cellCount,
  peak_nominal_mm_h: z.number().min(0).max(3276.7).nullable(),
  degraded: cellCount, wet_degraded: cellCount, missing_or_bad: cellCount,
});
export const sampleSchema = z.object({
  source: z.object({
    provider: z.literal(source.provider), data_kind: z.literal(source.data_kind), transformation: z.literal(source.transformation),
    rate_unit: z.literal(source.rate_unit), grid_spacing_degrees: z.literal(source.grid_spacing_degrees),
    inner_radius_km: z.literal(source.inner_radius_km), outer_radius_km: z.literal(source.outer_radius_km),
  }),
  status: z.enum(['available', 'partial', 'no_usable_cells', 'outside_extent']),
  point: weatherPointSchema, edge_clipped: z.boolean(),
  metadata: z.object({
    coverage_start: z.string().datetime(), coverage_end: z.string().datetime(), created: z.string().datetime(),
    sensors: z.array(z.string().max(30)).min(1).max(5), missing_inputs: z.number().int().min(0).max(4),
    pixel_observed_at: z.null(),
  }),
  areas: z.array(areaSchema).max(9),
  // Internal equality proofs for comparisons. Do not include these in Dot's tool output.
  nominal_cohorts: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(9),
});
export type RainRateSample = z.infer<typeof sampleSchema>;
type Metadata = RainRateSample['metadata'];
type Area = RainRateSample['areas'][number];

export function inRainRateExtent(point: WeatherPoint) {
  return point.latitude >= GRID.south && point.latitude <= GRID.north;
}

type ReadTile = (startRow: number, endRow: number, startColumn: number, endColumn: number) => {
  rain: Int16Array; quality: Int8Array;
};
function makeArea(area: Area['area']) {
  const counts: Area = {area, cells: 0, nominal: 0, wet_nominal: 0, peak_nominal_mm_h: null,
    degraded: 0, wet_degraded: 0, missing_or_bad: 0};
  return {counts, nominalCells: [] as number[]};
}

/** Summarize cell centres in a 20 km spherical disk, clipping latitude and wrapping longitude only. */
export function summarizeRainRate(point: WeatherPoint, metadata: Metadata, read: ReadTile): RainRateSample {
  if (!inRainRateExtent(point)) return {source, status: 'outside_extent', point, metadata, edge_clipped: true, areas: [], nominal_cohorts: []};
  const lat = point.latitude * TO_RAD, radius = source.outer_radius_km / EARTH_KM;
  const latDelta = radius / TO_RAD, lonDelta = Math.asin(Math.sin(radius) / Math.cos(lat)) / TO_RAD;
  const rowStart = Math.max(0, Math.ceil((GRID.north - point.latitude - latDelta) / GRID.step));
  const rowEnd = Math.min(GRID.rows, 1 + Math.floor((GRID.north - point.latitude + latDelta) / GRID.step));
  const column = (point.longitude - GRID.west) / GRID.step;
  const left = Math.ceil(column - lonDelta / GRID.step), right = 1 + Math.floor(column + lonDelta / GRID.step);
  const wrapped = ((left % GRID.cols) + GRID.cols) % GRID.cols, width = right - left;
  const ranges = [[wrapped, Math.min(GRID.cols, wrapped + width)]];
  if (wrapped + width > GRID.cols) ranges.push([0, wrapped + width - GRID.cols]);
  const regions = areaNames.map(makeArea);
  for (const [start, end] of ranges) {
    const {rain, quality} = read(rowStart, rowEnd, start, end);
    if (rain.length !== (rowEnd-rowStart)*(end-start) || rain.length !== quality.length) throw new Error('Invalid precipitation tile');
    for (let row = rowStart; row < rowEnd; row++) {
      const y = (GRID.north - row * GRID.step) * TO_RAD;
      for (let col = start; col < end; col++) {
        const dx = (GRID.west + col * GRID.step - point.longitude) * TO_RAD;
        const halfChord = Math.sin((y-lat)/2)**2 + Math.cos(lat)*Math.cos(y)*Math.sin(dx/2)**2;
        const distance = 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(halfChord)));
        if (distance > source.outer_radius_km) continue;
        const bearing = Math.atan2(Math.sin(dx)*Math.cos(y), Math.cos(lat)*Math.sin(y)-Math.sin(lat)*Math.cos(y)*Math.cos(dx)) / TO_RAD;
        const region = regions[distance <= source.inner_radius_km ? 0 : 1 + Math.floor(((bearing+382.5)%360)/45)];
        const idx = (row-rowStart)*(end-start) + col-start, raw = rain[idx], dqf = quality[idx];
        const counts = region.counts;
        counts.cells++;
        if (raw >= 0 && dqf === 0) {
          counts.nominal++;
          if (raw > 0) counts.wet_nominal++;
          counts.peak_nominal_mm_h = Math.max(counts.peak_nominal_mm_h ?? 0, raw/10);
          region.nominalCells.push(row * GRID.cols + col);
        } else if (raw >= 0 && dqf === 2) {
          counts.degraded++;
          if (raw > 0) counts.wet_degraded++;
        } else {
          // Fill, bad quality, and unknown or invalid values carry no dry/wet evidence.
          counts.missing_or_bad++;
        }
      }
    }
  }
  const edge_clipped = point.latitude+latDelta > GRID.north || point.latitude-latDelta < GRID.south;
  const areas = regions.map(r => r.counts);
  const incomplete = edge_clipped || areas.some(a => a.missing_or_bad > 0 || a.degraded > 0);
  const status = areas.every(a => a.nominal + a.degraded === 0) ? 'no_usable_cells' : incomplete ? 'partial' : 'available';
  const nominal_cohorts = regions.map(r => createHash('sha256').update(r.nominalCells.join(',')).digest('hex'));
  return {source, status, point, edge_clipped, metadata, areas, nominal_cohorts};
}

/** Compare the same nominal grid cells in distinct recent frames at the same place. */
export function compareRainRateSamples(previous: RainRateSample, current: RainRateSample) {
  const elapsed = Date.parse(current.metadata.coverage_start) - Date.parse(previous.metadata.coverage_start);
  if (elapsed <= 0 || elapsed > 30*60_000 || previous.point.latitude !== current.point.latitude ||
      previous.point.longitude !== current.point.longitude || previous.metadata.sensors.join(',') !== current.metadata.sensors.join(',')) return [];
  return current.areas.flatMap((area, i) => {
    const prior = previous.areas[i];
    if (!prior || prior.area !== area.area || area.nominal === 0 || current.nominal_cohorts[i] !== previous.nominal_cohorts[i]) return [];
    return [{area: area.area, nominal_cells: area.nominal, earlier_wet: prior.wet_nominal, later_wet: area.wet_nominal,
      earlier_peak_mm_h: prior.peak_nominal_mm_h, later_peak_mm_h: area.peak_nominal_mm_h}];
  });
}
