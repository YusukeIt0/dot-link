import {createHash} from 'node:crypto';
import {weatherQueryPoint, type WeatherPoint} from './types.ts';
import {compareRainRateSamples, inRainRateExtent} from './rain-rate/raster.ts';
import {FRAME_AGE} from './rain-rate/discovery.ts';
import {COOLDOWN, FETCH_TIMEOUT} from './rain-rate/cache.ts';
import type {NearbyRainRead, RainRateService} from './rain-rate/service.ts';

const iso = (instant: number) => new Date(instant).toISOString();
const source = {provider: 'NOAA/NESDIS Enterprise Rain Rate', product: 'BLEND instantaneous precipitation rate',
  attribution: 'Nearby estimates derived by Dot Link from NOAA Enterprise Rain Rate.',
  url: 'https://registry.opendata.aws/noaa-ghe/'};
const limitations = [
  'The central area is within 5 km; the eight compass sectors cover the ring from 5 to 20 km.',
  'The satellite grid estimates recent precipitation across an area. Individual cell observation times are unknown.',
  'Positive counts are cells with an estimated rate above zero. Coverage and cell counts do not give a probability of rain.',
  'Missing or degraded areas, zero estimates and differences between past frames cannot establish future arrival, personal exposure or safety.',
];
function clocks(read: NearbyRainRead) {
  const {sample, frame} = read;
  return {
    edition: createHash('sha256').update(JSON.stringify([frame.key, frame.etag, frame.checksum])).digest('hex'),
    coverage_start: sample.metadata.coverage_start, coverage_end: sample.metadata.coverage_end,
    file_interval_end: iso(frame.end),
    generated_at: iso(frame.created), published_at: iso(frame.published), first_retrieved_at: iso(frame.retrieved),
    acquisition_started_at: frame.requested === undefined ? null : iso(frame.requested),
  };
}
function project(read: NearbyRainRead, previous: NearbyRainRead | undefined, availableAt: number) {
  const {sample} = read;
  const matched = previous && compareRainRateSamples(previous.sample, sample);
  const comparison = previous && matched?.length ? {...clocks(previous), areas: matched} : undefined;
  const expires = Date.parse(sample.metadata.coverage_end) + FRAME_AGE;
  return {
    ...clocks(read), source, data_kind: 'satellite_precipitation_rate_estimate' as const,
    status: sample.status, resolution_degrees: sample.source.grid_spacing_degrees, rate_unit: sample.source.rate_unit,
    inner_radius_km: sample.source.inner_radius_km, outer_radius_km: sample.source.outer_radius_km,
    areas: sample.areas, edge_clipped: sample.edge_clipped, missing_inputs: sample.metadata.missing_inputs,
    pixel_observed_at: null, available_at: iso(availableAt), expires_at: iso(expires),
    ...(comparison ? {comparison} : {}), limitations,
  };
}
export type SatellitePrecipitation = ReturnType<typeof project>;
export function unavailableSatellite(point: WeatherPoint) {
  const outside = !inRainRateExtent(weatherQueryPoint(point));
  return {source, data_kind: 'satellite_precipitation_rate_estimate', status: outside ? 'outside_extent' : 'temporarily_unavailable',
    guidance: outside ? 'This place lies outside the product grid (60°S to 70°N).' :
      'No fresh verified local estimate is available for this read. Continue with useful evidence without polling or prompting for setup.'};
}
export function satelliteExpiry(value: SatellitePrecipitation) {
  const current = Date.parse(value.expires_at);
  return value.comparison ? Math.min(current, Date.parse(value.comparison.coverage_end) + FRAME_AGE) : current;
}
type Access = {
  guard: () => void; validUntil?: number; compare: boolean;
  record: (sample: SatellitePrecipitation) => void;
};
type Flight = {controller: AbortController; guard: () => void};
type Local = {value: SatellitePrecipitation; compared: boolean};
const keyOf = (point: WeatherPoint) => JSON.stringify(point);
const usable = (entry: Local | undefined, now: number) =>
  entry && Date.parse(entry.value.available_at) <= now && now < Date.parse(entry.value.expires_at) ? entry : undefined;

/** One per authorized WeatherContext. Only an explicit weather read can start
 * work. Disk frames are global; a handful of rounded local projections stay in RAM. */
export class SatelliteWeather {
  private readonly service: Pick<RainRateService, 'read' | 'refresh' | 'cancel' | 'close'>;
  private readonly now: () => number;
  private readonly results = new Map<string, Local>();
  private flight?: Flight;
  private lastAttempt = -Infinity;
  constructor(service: Pick<RainRateService, 'read' | 'refresh' | 'cancel' | 'close'>, now: () => number) {
    this.service = service; this.now = now;
  }
  revalidate() {
    try {this.flight?.guard();} catch {this.flight?.controller.abort();}
  }
  clear() {
    this.flight?.controller.abort(); this.service.cancel(); this.results.clear(); this.lastAttempt = -Infinity;
  }
  close() {this.clear(); this.service.close();}
  available(point: WeatherPoint, compare: boolean): SatellitePrecipitation | undefined {
    const value = usable(this.results.get(keyOf(weatherQueryPoint(point))), this.now())?.value;
    if (!value?.comparison || (compare && this.now() < satelliteExpiry(value))) return value;
    const {comparison: _comparison, ...single} = value;
    return single;
  }
  current(point: WeatherPoint, evidence: SatellitePrecipitation) {
    const latest = this.available(point, !!evidence.comparison);
    return latest?.edition === evidence.edition && (!evidence.comparison || latest.comparison?.edition === evidence.comparison.edition);
  }
  async select(raw: WeatherPoint, access: Access): Promise<void> {
    const point = weatherQueryPoint(raw);
    if (!inRainRateExtent(point)) return;
    const key = keyOf(point), now = this.now();
    if (this.flight) return;
    const cached = usable(this.results.get(key), now);
    const checkSource = now - this.lastAttempt >= COOLDOWN;
    if (!checkSource && cached && (!access.compare || cached.compared)) return;

    const controller = new AbortController();
    const timeout = Math.min(FETCH_TIMEOUT, (access.validUntil ?? Infinity) - now);
    if (timeout <= 0) return;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.ceil(timeout))]);
    const guard = () => {signal.throwIfAborted(); access.guard();};
    const flight = {controller, guard};
    this.flight = flight;
    const sample = async () => {
      guard();
      const [current, previous] = await this.service.read(point, signal, {previous: access.compare});
      guard();
      if (!current) return;
      const at = this.now();
      const value = project(current, previous, at);
      if (at >= satelliteExpiry(value)) return;
      const original = this.results.get(key)?.value;
      if (original?.edition === value.edition) value.available_at = original.available_at;
      this.results.delete(key);
      this.results.set(key, {value, compared: access.compare});
      while (this.results.size > 8) this.results.delete(this.results.keys().next().value!);
      access.record(value);
    };
    // A cache miss can finish immediately. The global download continues under
    // the initiating owner's grant and location deadline after a timely MET response.
    const local = cached && (!access.compare || cached.compared) ? Promise.resolve() : sample();
    const finish = async () => {
      await local;
      guard();
      if (!checkSource) return;
      this.lastAttempt = this.now();
      const result = await this.service.refresh(signal);
      guard();
      if (result === 'updated') this.results.clear();
      if (result === 'updated' || (result === 'cached' && !this.available(point, access.compare))) await sample();
    };
    void finish().catch(() => {}).finally(() => {if (this.flight === flight) this.flight = undefined;});
    // A slow local worker or a pair of region samples must not hold up the primary forecast.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {await Promise.race([local.catch(() => {}), new Promise<void>(resolve => {timer = setTimeout(resolve, 600); timer.unref();})]);}
    finally {if (timer) clearTimeout(timer);}
  }
}
