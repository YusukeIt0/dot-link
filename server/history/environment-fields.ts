import { createHash } from 'node:crypto';
import { weatherArchiveForecast, type WeatherEvidence, type WeatherPoint, type WeatherSample } from '../weather/types.ts';
import type { MobilityArguments } from '../mobility/context.ts';
import type { ArchiveInput, ArchiveRecord } from './archive-store.ts';

export const environmentFields = {
  weather: ['temperature', 'humidity', 'wind', 'pressure', 'cloud', 'precipitation', 'place', 'status'],
  mobility: ['plan', 'endpoints', 'steps', 'geometry', 'terrain', 'terrain_details'],
} as const;
export type EnvironmentWriter = ((record: ArchiveInput) => void) & {readonly since: number};
export type CaptureEnvironment = (owner: string) => EnvironmentWriter | undefined;
export type WeatherScope = {mode: 'current'; location_measured_at: string} |
  {mode: 'specified'; place: WeatherPoint & {label: string; source: string; reference: string}};
type Window = {start: number; end: number};
type Values = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function captureEnvironment(capture: CaptureEnvironment | undefined, owner: string) {
  try { return capture?.(owner); } catch { return undefined; }
}

interface ForecastPart {
  kind: 'model_forecast'; revision: string; scope_id: string; scope: WeatherScope; source: WeatherEvidence['source'];
  query_point: WeatherPoint; issued_at: string | null; first_retrieved_at: string | null; checked_at: string | null;
  as_of: string; status: WeatherEvidence['status']; limitations: string[]; elevation_m: number | null;
  samples: readonly WeatherSample[];
}

/** Keep provider validity, local knowledge and source issue time independent. */
export function weatherArchiveRecords(evidence: WeatherEvidence, scope: WeatherScope, archivedAt: number): ArchiveInput[] {
  const forecast = weatherArchiveForecast.get(evidence);
  const edition = forecast?.samples ?? [...(evidence.current ? [evidence.current] : []), ...evidence.forecast];
  const scopeId = digest([scope.mode, scope.mode === 'specified' ? scope.place : evidence.query_point]);
  const revision = digest([evidence.source.provider, evidence.query_point, evidence.updated_at, evidence.retrieved_at,
    evidence.elevation_m, forecast?.edition ?? edition]);
  const anchorMs = evidence.retrieved_at ? Date.parse(evidence.retrieved_at) : archivedAt;
  const checkpoint = digest([scopeId, revision, evidence.checked_at, evidence.status, evidence.limitations,
    // A truly unavailable read has no edition. Keep at most one equal failure per UTC hour.
    !edition.length && !evidence.retrieved_at ? Math.floor(archivedAt / 3_600_000) : null]);
  const common = {kind: 'model_forecast' as const, revision, scope_id: scopeId, scope, source: evidence.source,
    query_point: evidence.query_point, issued_at: evidence.updated_at, first_retrieved_at: evidence.retrieved_at,
    checked_at: evidence.checked_at, as_of: evidence.as_of, status: evidence.status, limitations: evidence.limitations,
    elevation_m: evidence.elevation_m};
  const records: ArchiveInput[] = [];
  // Small validity groups keep requested records and projected answers bounded.
  for (let i = 0; i < Math.max(edition.length, 1); i += 8) {
    const samples = edition.slice(i, i + 8);
    const starts = samples.flatMap(s => [Date.parse(s.valid_at), ...s.precipitation.map(p => Date.parse(p.from))]);
    const ends = samples.flatMap(s => [Date.parse(s.valid_at) + 1, ...s.precipitation.map(p => Date.parse(p.until))]);
    records.push({version: 1, id: 'weather:' + checkpoint + ':' + i,
      fromMs: starts.length ? Math.min(...starts) : archivedAt, toMs: ends.length ? Math.max(...ends) : archivedAt + 1,
      anchorMs, availableAtMs: archivedAt, payload: {...common, samples} satisfies ForecastPart});
  }
  return records;
}

const weatherMetrics = {temperature: ['temperature_c'], humidity: ['humidity_percent'], wind: ['wind_m_s', 'wind_from_degrees'],
  pressure: ['pressure_hpa'], cloud: ['cloud_percent']} as const;
function forecastProjection(snapshot: ForecastPart, fields: readonly string[], window: Window, row: ArchiveRecord) {
  const forecast: Values[] = [];
  for (const s of snapshot.samples) {
    const instant = Date.parse(s.valid_at);
    const inside = window.start <= instant && instant < window.end;
    const intervals = s.precipitation.filter(p => Date.parse(p.from) < window.end && Date.parse(p.until) > window.start);
    const projected: Values = {valid_at: s.valid_at};
    if (inside) {
      for (const [field, keys] of Object.entries(weatherMetrics)) {
        if (fields.includes(field)) for (const key of keys) projected[key] = s[key];
      }
    }
    if (fields.includes('precipitation') && (inside || intervals.length)) projected.precipitation = intervals;
    if (inside && fields.includes('temperature')) projected.apparent_temperature_c = null;
    if (Object.keys(projected).length > 1 || inside && (fields.includes('place') || fields.includes('status')))
      forecast.push(projected);
  }
  if (!forecast.length && (snapshot.samples.length || !fields.includes('status'))) return null;
  return {kind: snapshot.kind, revision: snapshot.revision, scope_id: snapshot.scope_id, scope: snapshot.scope.mode,
    issued_at: snapshot.issued_at, first_retrieved_at: snapshot.first_retrieved_at, checked_at: snapshot.checked_at,
    as_of: snapshot.as_of, available_at: iso(row.availableAtMs), status: snapshot.status, source: snapshot.source,
    limitations: snapshot.limitations, forecast,
    ...(fields.includes('place') ? {place: {...snapshot.scope, query_point: snapshot.query_point, model_elevation_m: snapshot.elevation_m}} : {})};
}

const object = (v: unknown): Values => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Values : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
function select(v: unknown, keys: readonly string[]) {
  const input = object(v);
  return Object.fromEntries(keys.filter(k => Object.hasOwn(input, k)).map(k => [k, input[k]]));
}
const coords = (v: unknown) => select(v, ['latitude', 'longitude']);
const mobilitySource = {
  walking: {credit: '© OpenStreetMap contributors via FOSSGIS OSRM', license: 'ODbL 1.0',
    license_url: 'https://www.openstreetmap.org/copyright', fix_map_url: 'https://www.openstreetmap.org/fixthemap'},
  terrain: {credit: 'Mapzen Terrain Tiles; derived from model elevations', dataset_url: 'https://registry.opendata.aws/terrain-tiles/',
    attribution_url: 'https://github.com/tilezen/joerd/blob/d8f587b73d26e0a0c42cdccd9ae8c55de4197763/docs/attribution.md'},
};
interface PlanPart {
  kind: 'planned_route_or_model_terrain'; status: 'finished'; plan_id: string; requested_at: string; retrieved_at: string;
  location_measured_at: string; walking_requested: boolean; terrain_requested: boolean;
  limitations: unknown; walking_status: unknown; terrain_status: unknown; values: Values;
}
/** Archive normalized results already returned by the mobility service. Split
 * large route detail while retaining candidate indices, sequence and omissions. */
export function mobilityArchiveRecords(input: MobilityArguments, measuredAt: string, result: unknown, archivedAt: number): ArchiveInput[] {
  const data = object(result);
  if (data.status !== 'finished' || typeof data.retrieved_at !== 'string' || typeof data.requested_at !== 'string') return [];
  const walking = object(data.walking), terrain = object(data.terrain), candidates = array(walking.candidates).map(object);
  const available = Date.parse(data.retrieved_at);
  const destination = input.destination ? select(input.destination, ['latitude', 'longitude', 'source', 'reference']) : null;
  const origin = coords(data.origin);
  const planId = digest([data.requested_at, data.retrieved_at, origin, destination, input.walking, input.terrain]);
  const common = {kind: 'planned_route_or_model_terrain' as const, status: 'finished' as const, plan_id: planId, requested_at: data.requested_at,
    retrieved_at: data.retrieved_at, location_measured_at: measuredAt, walking_requested: input.walking, terrain_requested: input.terrain,
    walking_status: walking.status, terrain_status: terrain.status, limitations: data.limitations};
  const groups: Values[] = [{
    plan: {...select(walking, ['source', 'retrieved_at', 'limitations', 'attribution_url', 'fix_map_url']),
      candidates: candidates.map((c,i) => ({candidate_index: i, ...select(c, ['distance_m','estimated_seconds','contains_ferry','omitted_steps']),
        geometry_omitted: object(c.geometry).omitted}))},
    endpoints: {origin, destination, graph_endpoints: array(walking.endpoints).map(p => ({
      ...select(p,['distance_from_requested_point_m','connector_access']), position: coords(object(p).position)}))},
    terrain: select(terrain, ['source','model','confidence','zoom','attribution_url','sampled_at','walking_candidate_index',
      'sample_count','sample_spacing_m','raster_spacing_m_at_start','covered_segments','total_segments','origin_elevation_m',
      'destination_elevation_m','elevation_difference_m','ascent_m','descent_m','maximum_sampled_grade_percent',
      'steep_section_threshold_percent','omitted_steep_sections','limitations']),
    terrain_details: {...select(terrain, ['walking_candidate_index','elevations_m','omitted_steep_sections']),
      ...(terrain.points ? {points: array(terrain.points).map(coords)} : {}),
      ...(terrain.steep_sections ? {steep_sections: array(terrain.steep_sections).map(s => ({
        ...select(s,['start_distance_m','length_m','sampled_grade_percent']), from: coords(object(s).from), to: coords(object(s).to)}))} : {})},
  }];
  for (const [candidate_index, c] of candidates.entries()) {
    const steps = array(c.steps);
    for (let i = 0; i < Math.max(steps.length, 1); i += 12) {
      groups.push({steps: {candidate_index, first_index: i, retained_steps: steps.length, omitted_steps: c.omitted_steps,
        values: steps.slice(i, i + 12).map(s => ({...select(s,['name','mode','distance_m','estimated_seconds','maneuver','direction']), position: coords(object(s).position)}))}});
    }
    const geometry = object(c.geometry);
    const text = typeof geometry.value === 'string' ? geometry.value : '';
    const partCount = Math.max(1, Math.ceil(text.length / 8192));
    for (let i = 0; i < partCount; i++) {
      groups.push({geometry: {candidate_index, ...select(geometry,['format','precision','omitted']),
        part_index: i, part_count: partCount, value: text.slice(i * 8192, (i + 1) * 8192)}});
    }
  }
  return groups.map((values,i) => ({id: 'mobility:' + planId + ':' + i, version: 1,
    fromMs: available, toMs: available + 1, anchorMs: available, availableAtMs: archivedAt,
    payload: {...common, values} satisfies PlanPart}));
}

export function projectEnvironment(source: 'weather' | 'mobility', row: ArchiveRecord, fields: readonly string[], window: Window): object | null {
  if (row.version !== 1 || row.fromMs >= window.end || row.toMs <= window.start) return null;
  const data = row.payload as ForecastPart | PlanPart | null;
  if (data?.kind === 'model_forecast' && source === 'weather') return forecastProjection(data, fields, window, row);
  if (data?.kind !== 'planned_route_or_model_terrain' || source !== 'mobility') return null;
  const selected = select(data.values, fields.filter(field => environmentFields.mobility.some(name => name === field)));
  if (!Object.keys(selected).length) return null;
  return {...select(data, ['kind','status','plan_id','requested_at','retrieved_at','location_measured_at','walking_requested',
    'terrain_requested','walking_status','terrain_status','limitations']), available_at: iso(row.availableAtMs), attribution: {
    ...(data.walking_requested ? {walking: mobilitySource.walking} : {}),
    ...(data.terrain_requested ? {terrain: mobilitySource.terrain} : {}),
  }, ...selected};
}
