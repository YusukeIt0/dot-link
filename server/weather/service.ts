import { createHash } from 'node:crypto';
import { WeatherCache, pruneWeatherCache, type WeatherCacheEntry, type WeatherCacheState } from './cache.ts';
import { MetNorwayProvider, WeatherSourceError } from './met-norway.ts';
import { weatherQueryPoint, weatherSource, type WeatherEvidence, type WeatherPoint, type WeatherProvider } from './types.ts';

const HOUR = 3_600_000;
const limitations = [
  'Model forecast, not a measurement at the requested position. Current means a forecast valid near the present time.',
  'Query coordinates are rounded to 0.01 degrees. Regional detail varies; global model spacing is approximately 9 km, Nordic/Arctic short-range models approximately 2.5 km. The response does not identify the selected model.',
  'Complex terrain, coastlines and local showers may not be resolved. Elevation is provider model terrain, not a phone altitude measurement.',
  'Precipitation applies to its explicit future interval, not an instantaneous rain observation. Missing fields are unknown, not zero.',
  'No apparent temperature or safety recommendation is calculated by Dot Link.',
];
function useful(sample: WeatherEvidence['current']) {
  return !!sample && (sample.temperature_c !== null || sample.humidity_percent !== null || sample.wind_m_s !== null || sample.precipitation.some(p => p.amount_mm !== null));
}

export function weatherEvidence(point: WeatherPoint, entry: WeatherCacheEntry | undefined, now: number, failure?: string): WeatherEvidence {
  const data = entry?.forecast;
  const samples = data?.samples ?? [];
  const current = [...samples].reverse().find(s => Date.parse(s.valid_at) <= now && now - Date.parse(s.valid_at) <= 90 * 60_000) ?? null;
  const forecast = samples.filter(s => Date.parse(s.valid_at) > now && Date.parse(s.valid_at) <= now + 36 * HOUR).slice(0, 37);
  const aged = !!data && (entry?.refreshFailed || Date.parse(data.updated_at) > now + 300_000 || now - Date.parse(data.updated_at) > 18 * HOUR || now - (entry?.checkedAt ?? 0) >= 24 * HOUR);
  const complete = current && [current.temperature_c, current.humidity_percent, current.wind_m_s].every(v => v !== null) && current.precipitation.some(p => p.amount_mm !== null);
  const any = useful(current) || forecast.some(useful);
  return {status: !any ? 'unavailable' : aged || failure ? 'stale' : complete ? 'ready' : 'partial',
    source: weatherSource, data_kind: 'model_forecast', query_point: point, as_of: new Date(now).toISOString(),
    retrieved_at: data && entry ? new Date(entry.retrievedAt).toISOString() : null,
    checked_at: data && entry ? new Date(entry.checkedAt).toISOString() : null,
    updated_at: data?.updated_at ?? null,
    retry_at: entry && entry.nextRequestAt > now ? new Date(entry.nextRequestAt).toISOString() : null,
    elevation_m: data?.elevation_m ?? null, current: useful(current) ? current : null, forecast,
    apparent_temperature_c: null,
    limitations: [...limitations, ...(!current ? ['No forecast sample covers the current time; do not present a future sample as current conditions.'] : []),
      ...(aged ? ['The model update or cache is old; this is not fresh weather evidence.'] : []),
      ...(entry?.deprecated ? ['The provider marked this API deprecated; maintainer migration is required.'] : []),
      ...(failure ? [failure] : [])],
  };
}

/** Bounded acquisition shared by both location modes; callers own authorization. */
export class WeatherService {
  private readonly cache: Pick<WeatherCache, 'read' | 'write'>;
  private readonly provider: WeatherProvider;
  private readonly now: () => number;
  private readonly random: () => number;
  private state?: WeatherCacheState;
  private loading?: Promise<WeatherCacheState>;
  private active = false;
  private controller?: AbortController;
  private maintenance?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(path: string, options: {provider?: WeatherProvider; cache?: Pick<WeatherCache, 'read' | 'write'>; now?: () => number; random?: () => number} = {}) {
    this.cache = options.cache ?? new WeatherCache(path); this.provider = options.provider ?? new MetNorwayProvider();
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
  }
  private async initialize() {
    this.loading ??= this.cache.read().then(async state => {
      pruneWeatherCache(state, this.now()); await this.cache.write(state); this.state = state;
      if (!this.closed) {this.maintenance = setInterval(() => {void this.maintain().catch(() => {});}, HOUR); this.maintenance.unref();}
      return state;
    }).catch(error => {this.loading = undefined; throw error;});
    return this.loading;
  }
  private async maintain() {
    if (!this.state || this.active || this.closed) return;
    this.active = true;
    try {pruneWeatherCache(this.state, this.now()); await this.cache.write(this.state);} finally {this.active = false;}
  }
  cancel() {this.controller?.abort();}
  close() {this.closed = true; this.cancel(); if (this.maintenance) clearInterval(this.maintenance);}
  async query(rawPoint: WeatherPoint, signal: AbortSignal, guard: () => void): Promise<WeatherEvidence> {
    guard(); signal.throwIfAborted();
    if (this.closed) throw new Error('Weather service closed');
    const point = weatherQueryPoint(rawPoint);
    const key = createHash('sha256').update(JSON.stringify([this.provider.id, point])).digest('hex');
    let state: WeatherCacheState;
    try {state = await this.initialize();} catch {guard(); signal.throwIfAborted(); return weatherEvidence(point, undefined, this.now(), 'Local cache is unavailable; no external request was made.');}
    guard(); signal.throwIfAborted();
    if (this.closed) throw new Error('Weather service closed');
    const now = this.now();
    let entry = state.entries.find(e => e.key === key);
    if (entry?.nextRequestAt && entry.nextRequestAt > now) return weatherEvidence(point, entry, now);
    if (this.active || state.nextRequestAt > now) return weatherEvidence(point, entry, now, 'Weather source is cooling down or busy; do not poll or retry immediately.');
    this.active = true;
    const controller = new AbortController(); this.controller = controller;
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(20_000)]);
    const check = () => {combined.throwIfAborted(); guard(); if (this.closed) throw new Error('Weather service closed');};
    try {
      pruneWeatherCache(state, now);
      entry = state.entries.find(e => e.key === key);
      if (!entry && state.entries.length >= 64) return weatherEvidence(point, undefined, now, 'Weather cache capacity is temporarily exhausted; do not retry immediately.');
      if (!entry) {entry = {key, nextRequestAt: 0, retrievedAt: 0, checkedAt: 0, deprecated: false, refreshFailed: true}; state.entries.push(entry);}
      // Persist before sending: a crash/restart cannot immediately repeat a query.
      entry.nextRequestAt = now + 3 * HOUR + Math.floor(Math.max(0, Math.min(1, this.random())) * 5 * 60_000);
      entry.refreshFailed = true;
      state.nextRequestAt = now + 60_000;
      await this.cache.write(state); check();
      let abort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {abort = () => reject(new Error('Weather request cancelled')); combined.addEventListener('abort', abort, {once: true});});
      let response;
      try {response = await Promise.race([this.provider.load(point, entry.forecast ? entry.lastModified : undefined, combined), cancelled]);}
      finally {combined.removeEventListener('abort', abort);}
      check();
      if (response.notModified && !entry.forecast) throw new Error('Weather cache miss on revalidation');
      if (!response.notModified && !response.forecast) throw new Error('Weather provider returned no evidence');
      if (response.forecast) {entry.forecast = response.forecast; entry.retrievedAt = this.now();}
      entry.checkedAt = this.now(); entry.deprecated = response.deprecated; entry.refreshFailed = false;
      if (response.lastModified) entry.lastModified = response.lastModified;
      else if (!response.notModified) delete entry.lastModified;
      if (response.expiresAt !== undefined && Number.isFinite(response.expiresAt)) entry.nextRequestAt = Math.max(entry.nextRequestAt, response.expiresAt);
      pruneWeatherCache(state, this.now()); await this.cache.write(state); check();
      return weatherEvidence(point, entry, this.now());
    } catch (error) {
      check();
      if (entry) entry.refreshFailed = true;
      if (error instanceof WeatherSourceError && error.retryAt !== undefined && Number.isFinite(error.retryAt)) {
        state.nextRequestAt = Math.max(state.nextRequestAt, error.retryAt);
        if (entry) entry.nextRequestAt = Math.max(entry.nextRequestAt, error.retryAt);
        await this.cache.write(state).catch(() => {});
      }
      return weatherEvidence(point, entry, this.now(), 'The weather refresh failed. Retained values, if any, are earlier forecasts; unavailable data are unknown.');
    } finally {if (this.controller === controller) this.controller = undefined; this.active = false;}
  }
}
