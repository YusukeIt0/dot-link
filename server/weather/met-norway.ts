import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { weatherForecastSchema, type WeatherForecast, type WeatherPoint, type WeatherProvider, type WeatherProviderResult, type WeatherSample } from './types.ts';

const {version} = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {version: string};
const HOUR = 3_600_000;
const MAX_BYTES = 512 * 1024;
const details = z.record(z.string(), z.unknown());
const period = z.object({summary: z.object({symbol_code: z.unknown().optional()}).optional(), details: details.optional()});
const documentSchema = z.object({
  geometry: z.object({type: z.literal('Point'), coordinates: z.array(z.number().finite()).min(2).max(3)}),
  properties: z.object({
    meta: z.object({updated_at: z.string().datetime(), units: z.record(z.string(), z.string())}),
    timeseries: z.array(z.object({time: z.string().datetime(), data: z.object({
      instant: z.object({details}), next_1_hours: period.optional(), next_6_hours: period.optional(), next_12_hours: period.optional(),
    })})).min(1).max(400),
  }),
});

export class WeatherSourceError extends Error {
  readonly retryAt?: number;
  constructor(message: string, retryAt?: number) {super(message); this.retryAt = retryAt;}
}

/** Unknown/additive provider fields are ignored; invalid numeric fields stay missing. */
export function parseMetForecast(raw: unknown, query: WeatherPoint, now: number): WeatherForecast {
  const parsed = documentSchema.parse(raw);
  const {meta, timeseries} = parsed.properties;
  const [longitude, latitude, elevation] = parsed.geometry.coordinates;
  if (Math.abs(latitude - query.latitude) > 0.0001 || Math.abs(longitude - query.longitude) > 0.0001) throw new Error('Weather coordinate mismatch');
  if (Date.parse(meta.updated_at) > now + 5 * 60_000) throw new Error('Future weather update');
  let previous = -Infinity;
  for (const sample of timeseries) {
    const at = Date.parse(sample.time);
    if (at <= previous) throw new Error('Unordered weather times');
    previous = at;
  }
  const number = (data: Record<string, unknown>, field: string, unit: string, low: number, high: number): number | null => {
    const value = data[field];
    return meta.units[field] === unit && typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high ? value : null;
  };
  const samples: WeatherSample[] = timeseries.filter(s => Date.parse(s.time) >= now - HOUR && Date.parse(s.time) <= now + 48 * HOUR).slice(0, 64).map(s => {
    const d = s.data.instant.details;
    const precipitation: WeatherSample['precipitation'] = [];
    for (const hours of [1, 6, 12] as const) {
      const p = s.data[`next_${hours}_hours`];
      if (!p) continue;
      const symbol = p.summary?.symbol_code;
      precipitation.push({from: s.time, until: new Date(Date.parse(s.time) + hours * HOUR).toISOString(), hours,
        amount_mm: number(p.details ?? {}, 'precipitation_amount', 'mm', 0, 3000),
        probability_percent: number(p.details ?? {}, 'probability_of_precipitation', '%', 0, 100),
        symbol: typeof symbol === 'string' && /^[a-z_]{1,80}$/.test(symbol) ? symbol : null});
    }
    return {valid_at: s.time, temperature_c: number(d, 'air_temperature', 'celsius', -100, 70),
      humidity_percent: number(d, 'relative_humidity', '%', 0, 100),
      wind_m_s: number(d, 'wind_speed', 'm/s', 0, 150), wind_from_degrees: number(d, 'wind_from_direction', 'degrees', 0, 360),
      pressure_hpa: number(d, 'air_pressure_at_sea_level', 'hPa', 700, 1200), cloud_percent: number(d, 'cloud_area_fraction', '%', 0, 100), precipitation};
  });
  return weatherForecastSchema.parse({provider: 'met-norway-locationforecast-2', updated_at: meta.updated_at,
    point: query, elevation_m: typeof elevation === 'number' && elevation >= -500 && elevation <= 9000 ? elevation : null, samples});
}

/** Fixed HTTPS service, bounded same-origin redirects and decompressed body size. */
export class MetNorwayProvider implements WeatherProvider {
  readonly id = 'met-norway-locationforecast-2' as const;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  constructor(request: typeof fetch = fetch, now = Date.now) {this.request = request; this.now = now;}
  async load(point: WeatherPoint, lastModified: string | undefined, signal: AbortSignal): Promise<WeatherProviderResult> {
    const query = new URL('https://api.met.no/weatherapi/locationforecast/2.0/compact');
    query.searchParams.set('lat', point.latitude.toFixed(2)); query.searchParams.set('lon', point.longitude.toFixed(2));
    const combined = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const headers: Record<string, string> = {'User-Agent': `Dot-Link/${version} (+https://github.com/YusukeIt0/dot-link)`, 'Accept-Encoding': 'gzip, deflate'};
    if (lastModified && Number.isFinite(Date.parse(lastModified)) && Date.parse(lastModified) <= this.now()) headers['If-Modified-Since'] = lastModified;
    let url = query;
    for (let redirects = 0; redirects <= 2; redirects++) {
      combined.throwIfAborted();
      const response = await this.request(url, {headers, signal: combined, redirect: 'manual', credentials: 'omit'});
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = new URL(response.headers.get('location') ?? '', url);
          if (redirects === 2 || next.origin !== query.origin || next.username || next.password || next.hash || next.pathname !== query.pathname || next.search !== query.search) throw new Error('Unsupported weather redirect');
          url = next; continue;
        }
        const expiry = Date.parse(response.headers.get('expires') ?? '');
        const modified = response.headers.get('last-modified') ?? undefined;
        const result = {notModified: response.status === 304, deprecated: response.status === 203,
          expiresAt: Number.isFinite(expiry) ? expiry : undefined,
          lastModified: modified && modified.length <= 100 && Number.isFinite(Date.parse(modified)) && Date.parse(modified) <= this.now() ? modified : undefined};
        if (response.status === 304) return result;
        if (![200, 203].includes(response.status) || !response.body) {
          const retry = response.headers.get('retry-after');
          const retryAt = retry && /^\d+$/.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry ?? '');
          throw new WeatherSourceError('Weather source unavailable', Number.isFinite(retryAt) ? Math.min(8_640_000_000_000_000, retryAt) : undefined);
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error('Weather response too large');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          for (;;) {
            combined.throwIfAborted();
            const {done, value} = await reader.read();
            combined.throwIfAborted();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES) throw new Error('Weather response too large');
            chunks.push(value);
          }
        } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
        const raw = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        combined.throwIfAborted();
        return {...result, forecast: parseMetForecast(raw, point, this.now())};
      } finally {if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});}
    }
    throw new Error('Weather redirect limit');
  }
}
