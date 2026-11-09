import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetNorwayProvider, parseMetForecast, WeatherSourceError } from '../server/weather/met-norway.ts';
import { WeatherCache, pruneWeatherCache, type WeatherCacheState } from '../server/weather/cache.ts';
import { WeatherService } from '../server/weather/service.ts';
import { weatherQueryPoint, type WeatherPoint, type WeatherProvider, type WeatherProviderResult } from '../server/weather/types.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-10T09:20:00Z');
const POINT = {latitude: 35.68, longitude: 139.76}; // Public Tokyo fixture, never a phone fix.
function fixture(point = POINT, now = NOW) {
  return {type: 'Feature', geometry: {type: 'Point', coordinates: [point.longitude, point.latitude, 30]}, properties: {
    meta: {updated_at: new Date(now - HOUR).toISOString(), units: {air_temperature: 'celsius', relative_humidity: '%', wind_speed: 'm/s',
      wind_from_direction: 'degrees', air_pressure_at_sea_level: 'hPa', cloud_area_fraction: '%', precipitation_amount: 'mm'}},
    timeseries: Array.from({length: 50}, (_, i) => ({time: new Date(Math.floor(now / HOUR) * HOUR + i * HOUR).toISOString(), data: {
      instant: {details: {air_temperature: 20 + i / 10, relative_humidity: 70, wind_speed: 3, wind_from_direction: 90, air_pressure_at_sea_level: 1010, cloud_area_fraction: 50}},
      next_1_hours: {summary: {symbol_code: 'lightrain'}, details: {precipitation_amount: 0.5}},
    }})),
  }};
}
class MemoryCache {
  state: WeatherCacheState = {version: 1, nextRequestAt: 0, entries: []};
  writes = 0;
  async read() {return structuredClone(this.state);}
  async write(state: WeatherCacheState) {this.writes++; this.state = structuredClone(state);}
}
function serviceFixture(t: TestContext) {
  let now = NOW; let calls = 0;
  const cache = new MemoryCache();
  let load: WeatherProvider['load'] = async point => ({forecast: parseMetForecast(fixture(point, now), point, now), notModified: false, deprecated: false,
    lastModified: new Date(now - HOUR).toUTCString()});
  const provider: WeatherProvider = {id: 'met-norway-locationforecast-2', load: (...args) => {calls++; return load(...args);}};
  const create = () => {const service = new WeatherService('/unused', {provider, cache, now: () => now, random: () => 0}); t.after(() => service.close()); return service;};
  const service = create();
  const query = (p = POINT, signal = new AbortController().signal, guard = () => {}) => service.query(p, signal, guard);
  return {service, query, cache, create, advance: (ms: number) => {now += ms;}, now: () => now, calls: () => calls, setLoad: (fn: WeatherProvider['load']) => {load = fn;}};
}

test('global coordinate cells handle negatives, poles and the antimeridian', () => {
  for (const point of [{latitude: 35.6762, longitude: 139.7601}, {latitude: -33.87, longitude: 151.21}, {latitude: -1.29, longitude: 36.82},
    {latitude: -3.12, longitude: -60.02}, {latitude: 27.99, longitude: 86.93}, {latitude: -80, longitude: 179.9999}]) {
    const query = weatherQueryPoint(point);
    assert.ok(Math.abs(query.latitude - point.latitude) <= .0051);
    assert.ok(Math.abs(query.longitude) <= 180);
    assert.equal(parseMetForecast(fixture(query), query, NOW).point.latitude, query.latitude);
  }
  assert.deepEqual(weatherQueryPoint({latitude: 90, longitude: 100}), {latitude: 90, longitude: 0});
  assert.deepEqual(weatherQueryPoint({latitude: -0.001, longitude: 180}), {latitude: 0, longitude: -180});
  for (const bad of [{latitude: 91, longitude: 0}, {latitude: NaN, longitude: 0}, {latitude: 0, longitude: Infinity}]) assert.throws(() => weatherQueryPoint(bad));
});

test('normalization preserves forecast timestamps, precipitation intervals and absent apparent temperature', async t => {
  const f = serviceFixture(t); const result = await f.query();
  assert.equal(result.status, 'ready'); assert.equal(result.data_kind, 'model_forecast');
  assert.equal(result.current?.valid_at, '2026-11-10T09:00:00.000Z');
  assert.equal(result.current?.precipitation[0].until, '2026-11-10T10:00:00.000Z');
  assert.equal(result.current?.precipitation[0].probability_percent, null);
  assert.equal(result.apparent_temperature_c, null); assert.equal(result.source.license, 'CC BY 4.0');
  assert.notEqual(result.updated_at, result.retrieved_at); assert.ok(result.forecast.length <= 37);
});

test('missing, invalid and wrong-unit values are unknown, never a dry-weather zero', () => {
  const raw = fixture();
  Object.assign(raw.properties.timeseries[0].data.instant.details, {air_temperature: null, wind_speed: '3', relative_humidity: 101});
  raw.properties.meta.units.precipitation_amount = 'inches';
  const data = parseMetForecast(raw, POINT, NOW).samples[0];
  assert.equal(data.temperature_c, null); assert.equal(data.humidity_percent, null); assert.equal(data.wind_m_s, null);
  assert.equal(data.precipitation[0].amount_mm, null);
});

test('unexpected additive provider fields are tolerated, malformed envelopes/time order/position are rejected', () => {
  const raw = {...fixture(), new_provider_field: 'ignored'};
  assert.equal(parseMetForecast(raw, POINT, NOW).samples[0].temperature_c, 20);
  assert.throws(() => parseMetForecast({}, POINT, NOW));
  const unordered = fixture(); unordered.properties.timeseries[1].time = unordered.properties.timeseries[0].time;
  assert.throws(() => parseMetForecast(unordered, POINT, NOW), /Unordered/);
  assert.throws(() => parseMetForecast(fixture(), {latitude: 0, longitude: 0}, NOW), /coordinate/);
  const future = fixture(); future.properties.meta.updated_at = new Date(NOW + HOUR).toISOString();
  assert.throws(() => parseMetForecast(future, POINT, NOW), /Future/);
});

test('future-only and missing current-time coverage never become current observations', async t => {
  const f = serviceFixture(t);
  f.setLoad(async point => {const raw = fixture(point); raw.properties.timeseries.splice(0, 2); return {notModified: false, deprecated: false, forecast: parseMetForecast(raw, point, NOW)};});
  const result = await f.query(); assert.equal(result.current, null); assert.equal(result.status, 'partial');
  assert.ok(result.forecast.length > 0); assert.match(result.limitations.join(' '), /No forecast sample covers/);
});

test('cached forecasts advance to their present valid hour without a new request', async t => {
  const f = serviceFixture(t); await f.query(); f.advance(HOUR);
  const result = await f.query(); assert.equal(f.calls(), 1); assert.equal(result.current?.valid_at, '2026-11-10T10:00:00.000Z');
  assert.equal(result.retrieved_at, new Date(NOW).toISOString());
});

test('request suppression survives restart and concurrent calls do not fan out', async t => {
  const f = serviceFixture(t); await Promise.all([f.query(), f.query(), f.query()]); assert.equal(f.calls(), 1);
  f.service.close(); const restarted = f.create();
  const result = await restarted.query(POINT, new AbortController().signal, () => {});
  assert.equal(result.status, 'ready'); assert.equal(f.calls(), 1);
  const point = {latitude: -1.29, longitude: 36.82};
  const throttled = await restarted.query(point, new AbortController().signal, () => {});
  assert.equal(throttled.status, 'unavailable'); assert.equal(f.calls(), 1);
});

test('Expires and conditional response maintain fetch time separately from validation time', async t => {
  const f = serviceFixture(t);
  f.setLoad(async point => ({forecast: parseMetForecast(fixture(point), point, NOW), notModified: false, deprecated: true,
    lastModified: new Date(NOW - HOUR).toUTCString(), expiresAt: NOW + 4 * HOUR}));
  await f.query(); f.advance(3 * HOUR); await f.query(); assert.equal(f.calls(), 1);
  f.advance(HOUR + 1);
  f.setLoad(async (_point, modified) => {assert.equal(modified, new Date(NOW - HOUR).toUTCString()); return {notModified: true, deprecated: false};});
  const result = await f.query(); assert.equal(f.calls(), 2);
  assert.equal(result.retrieved_at, new Date(NOW).toISOString()); assert.equal(result.checked_at, new Date(f.now()).toISOString());
});

test('refresh failure stays stale on later cache reads and respects provider retry-after', async t => {
  const f = serviceFixture(t); await f.query(); f.advance(3 * HOUR + 1);
  f.setLoad(async () => {throw new WeatherSourceError('fixture failure', f.now() + 5 * HOUR);});
  assert.equal((await f.query()).status, 'stale'); assert.equal((await f.query()).status, 'stale');
  f.advance(4 * HOUR); assert.equal((await f.query()).status, 'stale'); assert.equal(f.calls(), 2);
  assert.ok(f.cache.state.nextRequestAt > f.now());
});

test('old model data remains explicitly stale even after a successful HTTP fetch', async t => {
  const f = serviceFixture(t);
  f.setLoad(async point => {const raw = fixture(point); raw.properties.meta.updated_at = new Date(NOW - 20 * HOUR).toISOString(); return {notModified: false, deprecated: false, forecast: parseMetForecast(raw, point, NOW)};});
  assert.equal((await f.query()).status, 'stale');
});

test('revocation before network and during a late provider response cannot return evidence', async t => {
  const f = serviceFixture(t); let allowed = false;
  await assert.rejects(f.query(POINT, new AbortController().signal, () => {if (!allowed) throw new Error('revoked');}), /revoked/);
  assert.equal(f.calls(), 0); allowed = true;
  let resolve!: (result: WeatherProviderResult) => void;
  f.setLoad(() => new Promise(r => {resolve = r;}));
  const abort = new AbortController(); const pending = f.query(POINT, abort.signal, () => {if (!allowed) throw new Error('revoked');});
  while (!resolve) await new Promise(r => setImmediate(r));
  allowed = false; abort.abort(); await assert.rejects(pending);
  resolve({forecast: parseMetForecast(fixture(), POINT, NOW), notModified: false, deprecated: false});
  await new Promise(r => setImmediate(r)); assert.equal(f.cache.state.entries[0].forecast, undefined);
});

test('broken local persistence fails closed without contacting a provider', async t => {
  let calls = 0;
  const service = new WeatherService('/unused', {cache: {read: async () => {throw new Error('corrupt');}, write: async () => {}},
    provider: {id: 'met-norway-locationforecast-2', load: async () => {calls++; throw new Error('must not run');}}, now: () => NOW});
  t.after(() => service.close());
  assert.equal((await service.query(POINT, new AbortController().signal, () => {})).status, 'unavailable'); assert.equal(calls, 0);
});

test('cache prunes old forecasts but retains cooldowns and bounds retained coordinate payloads', () => {
  const state: WeatherCacheState = {version: 1, nextRequestAt: 0, entries: Array.from({length: 32}, (_, i) => ({key: i.toString(16).padStart(64, '0'), nextRequestAt: NOW + HOUR,
    retrievedAt: NOW, checkedAt: NOW - i, deprecated: false, refreshFailed: false, forecast: parseMetForecast(fixture(), POINT, NOW)}))};
  pruneWeatherCache(state, NOW); assert.equal(state.entries.filter(e => e.forecast).length, 16); assert.equal(state.entries.length, 32);
  pruneWeatherCache(state, NOW + 25 * HOUR); assert.equal(state.entries.length, 0);
});

test('cache file uses private permissions, validates size/schema and never follows a file symlink', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-weather-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'cache.json'), cache = new WeatherCache(path);
  const empty: WeatherCacheState = {version: 1, nextRequestAt: 0, entries: []};
  await cache.write(empty); assert.deepEqual(await cache.read(), empty); assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{}'); await assert.rejects(cache.read(), /unavailable/);
  await rm(path); const other = join(directory, 'private.txt'); await writeFile(other, 'private'); await symlink(other, path);
  await assert.rejects(cache.read()); assert.equal(await readFile(other, 'utf8'), 'private');
});

test('transport sends app identity, coarse coordinates and conditional header; never sends credentials', async () => {
  let called = false;
  const provider = new MetNorwayProvider(async (url, init) => {
    called = true; assert.match(String(url), /lat=35.68&lon=139.76/); assert.equal(init?.credentials, 'omit');
    const headers = new Headers(init?.headers); assert.match(headers.get('user-agent')!, /Dot-Link\/.+github.com\/YusukeIt0\/dot-link/);
    assert.equal(headers.get('if-modified-since'), new Date(NOW - HOUR).toUTCString());
    return new Response(JSON.stringify(fixture()), {headers: {'Expires': new Date(NOW + HOUR).toUTCString()}});
  }, () => NOW);
  const result = await provider.load(POINT, new Date(NOW - HOUR).toUTCString(), new AbortController().signal);
  assert.ok(called); assert.equal(result.forecast?.samples[0].temperature_c, 20); assert.equal(result.expiresAt, NOW + HOUR);
});

test('transport rejects foreign redirects and bounds actual body bytes even without content-length', async () => {
  let calls = 0;
  const redirect = new MetNorwayProvider(async () => {calls++; return new Response(null, {status: 302, headers: {location: 'https://example.test/steal'}});}, () => NOW);
  await assert.rejects(redirect.load(POINT, undefined, new AbortController().signal), /redirect/); assert.equal(calls, 1);
  const oversized = new MetNorwayProvider(async () => new Response('x'.repeat(512 * 1024 + 1)), () => NOW);
  await assert.rejects(oversized.load(POINT, undefined, new AbortController().signal), /too large/);
});

test('transport reports 203, 304 and rate limiting without exposing the request URL', async () => {
  const deprecated = new MetNorwayProvider(async () => new Response(JSON.stringify(fixture()), {status: 203}), () => NOW);
  assert.equal((await deprecated.load(POINT, undefined, new AbortController().signal)).deprecated, true);
  const unchanged = new MetNorwayProvider(async () => new Response(null, {status: 304}), () => NOW);
  assert.equal((await unchanged.load(POINT, undefined, new AbortController().signal)).notModified, true);
  const limited = new MetNorwayProvider(async () => new Response(null, {status: 429, headers: {'retry-after': '300'}}), () => NOW);
  await assert.rejects(limited.load(POINT, undefined, new AbortController().signal), error => error instanceof WeatherSourceError && error.retryAt === NOW + 300_000 && !error.message.includes('lat='));
});
