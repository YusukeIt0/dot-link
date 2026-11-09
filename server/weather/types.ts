import { z } from 'zod';

export const weatherPointSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
}).strict();
export type WeatherPoint = z.infer<typeof weatherPointSchema>;
const time = z.string().datetime();
const nullable = (minimum: number, maximum: number) => z.number().min(minimum).max(maximum).nullable();
export const weatherSampleSchema = z.object({
  valid_at: time,
  temperature_c: nullable(-100, 70), humidity_percent: nullable(0, 100),
  wind_m_s: nullable(0, 150), wind_from_degrees: nullable(0, 360),
  pressure_hpa: nullable(700, 1200), cloud_percent: nullable(0, 100),
  precipitation: z.array(z.object({
    from: time, until: time, hours: z.union([z.literal(1), z.literal(6), z.literal(12)]),
    amount_mm: nullable(0, 3000), probability_percent: nullable(0, 100),
    symbol: z.string().regex(/^[a-z_]{1,80}$/).nullable(),
  }).strict()).max(3),
}).strict();
export type WeatherSample = z.infer<typeof weatherSampleSchema>;
export const weatherForecastSchema = z.object({
  provider: z.literal('met-norway-locationforecast-2'),
  updated_at: time, point: weatherPointSchema, elevation_m: nullable(-500, 9000),
  samples: z.array(weatherSampleSchema).min(1).max(64),
}).strict();
export type WeatherForecast = z.infer<typeof weatherForecastSchema>;
export interface WeatherProviderResult {
  forecast?: WeatherForecast;
  notModified: boolean;
  expiresAt?: number;
  lastModified?: string;
  deprecated: boolean;
}
/** A provider owns transport/normalization, never consent, phone fixes or messages. */
export interface WeatherProvider {
  readonly id: WeatherForecast['provider'];
  load(point: WeatherPoint, lastModified: string | undefined, signal: AbortSignal): Promise<WeatherProviderResult>;
}
export const weatherSource = {
  name: 'MET Norway', provider: 'met-norway-locationforecast-2',
  url: 'https://api.met.no/weatherapi/locationforecast/2.0/documentation',
  license: 'CC BY 4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Based on data from MET Norway; normalized and subset by Dot Link.',
};
export interface WeatherEvidence {
  status: 'ready' | 'partial' | 'stale' | 'unavailable';
  source: typeof weatherSource;
  data_kind: 'model_forecast';
  query_point: WeatherPoint;
  as_of: string;
  retrieved_at: string | null;
  checked_at: string | null;
  updated_at: string | null;
  retry_at: string | null;
  elevation_m: number | null;
  current: WeatherSample | null;
  forecast: WeatherSample[];
  apparent_temperature_c: null;
  limitations: string[];
}

/** Approximate one-kilometre cells, no raw phone coordinates in weather storage. */
export function weatherQueryPoint(raw: WeatherPoint): WeatherPoint {
  const point = weatherPointSchema.parse(raw);
  const latitude = Math.round(point.latitude * 100) / 100;
  let longitude = Math.round(point.longitude * 100) / 100;
  if (longitude === 180) longitude = -180;
  return {latitude: Object.is(latitude, -0) ? 0 : latitude, longitude: Math.abs(latitude) === 90 ? 0 : Object.is(longitude, -0) ? 0 : longitude};
}
