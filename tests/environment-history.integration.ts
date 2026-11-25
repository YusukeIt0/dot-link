import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bridge } from '../server/bridge.ts';
import { deviceServer } from '../server/device.ts';
import { ArchiveAuthority } from '../server/history/archive-authority.ts';
import { EnvironmentHistory } from '../server/history/environment-history.ts';
import { bridgeServer } from '../server/http.ts';
import { LocationContext } from '../server/location.ts';
import { WeatherContext, SATELLITE_TERMS, WEATHER_TERMS } from '../server/weather/context.ts';
import { rainFrame } from './fixtures/rain-rate.ts';
import { weatherSource, type WeatherEvidence } from '../server/weather/types.ts';
import { WebhookSender } from '../server/webhook.ts';

test('paired weather grants preserve MET and admit only authorized NOAA summaries to independently guarded history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'environment-history-http-'));
  const tokens = {device: randomBytes(32).toString('hex'), mcp: randomBytes(32).toString('hex')};
  const owner = createHash('sha256').update(tokens.device).digest('hex');
  const master = randomBytes(32);
  const base = Date.now() - 4 * 3_600_000;
  let now = base;
  const iso = (ms: number) => new Date(ms).toISOString();
  const valid = base + 3 * 3_600_000;
  const authority = new ArchiveAuthority(join(dir, 'archive'), {
    create: async () => ({wrapped: 'test-envelope', key: Buffer.from(master)}), open: async () => Buffer.from(master),
  }, {ownerStatus: candidate => candidate === owner ? 'authorized' : 'unavailable', now: () => now});
  const environment = new EnvironmentHistory(authority, () => now);
  const sender = new WebhookSender(async () => ({status: 200, body: '{}'}));
  const bridge = new Bridge(join(dir, 'bridge.json'), sender, []);
  const locations = new LocationContext(join(dir, 'location.json'), sender, [], async () => ({}), () => now);
  let calls = 0;
  let temperature = 17;
  const frameStart = Math.floor((base - 20 * 60_000) / 600_000) * 600_000;
  let rainRequested = base, rainRetrieved = base, revision = 1, rainReads = 0, rainRefreshes = 0;
  const place = {latitude: 10, longitude: 20, label: 'Requested point', source: 'user_provided', reference: 'test request'};
  const weather = new WeatherContext(join(dir, 'weather.json'), {
    query: async (point, _signal, guard): Promise<WeatherEvidence> => {
      calls++; guard();
      return {status: 'partial', data_kind: 'model_forecast', source: weatherSource, query_point: point,
        retrieved_at: iso(now), checked_at: iso(now), updated_at: iso(now - 1), as_of: iso(now),
        retry_at: null, elevation_m: 10, current: null, apparent_temperature_c: null, limitations: [],
        forecast: [{valid_at: iso(valid), temperature_c: temperature, humidity_percent: 50, pressure_hpa: 1000,
          wind_m_s: 1, wind_from_degrees: 0, cloud_percent: 20, precipitation: []}]};
    }, cancel() {}, close() {},
  }, locations, {now: () => now, ownerAuthorized: candidate => candidate === owner, automatic: false,
    archive: candidate => environment.capture(candidate, 'weather'),
    satellite: {read: async point => {rainReads++; return [rainFrame(point, frameStart, rainRequested, rainRetrieved, revision)];},
      refresh: async () => {rainRefreshes++; return 'cached';}, cancel() {}, close() {}}});
  const relay = bridgeServer(bridge, tokens, undefined, locations, undefined, weather, undefined, undefined, {authority, environment});
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const relayURL = 'http://127.0.0.1:' + (relay.address() as AddressInfo).port;
  const gateway = deviceServer({token: tokens.device, origin: 'http://device.test', directory: dir, bridgeURL: relayURL, transcribe: async () => ''});
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const deviceURL = 'http://127.0.0.1:' + (gateway.address() as AddressInfo).port;
  t.after(async () => {
    for (const server of [gateway, relay]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    weather.close(); authority.close(); master.fill(0); rmSync(dir, {recursive: true, force: true});
  });
  function device(path: string, input?: unknown, token = tokens.device): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = request(deviceURL + path, {method: input === undefined ? 'GET' : 'POST', headers: {
        Host: 'device.test', Origin: 'http://device.test', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'X-G2-Location-Owner': 'f'.repeat(64),
      }}, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), {status: res.statusCode})));
      });
      req.on('error', reject); req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async function tool(name: string, args: unknown) {
    const r = await fetch(relayURL + '/mcp', {method: 'POST', headers: {Authorization: 'Bearer ' + tokens.mcp},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})});
    const rpc = await r.json(); return rpc.error ?? rpc.result.structuredContent;
  }
  const path = '/api/factor-history';
  const getStatus = async () => (await device(path)).json();
  const query = {start_at: iso(valid - 1), end_at: iso(valid + 1000), fields: {weather: ['temperature']}};
  async function change(value: unknown, accepted = true) {
    const status = await getStatus();
    return device(path, {protocol: status.protocol, epoch: status.epoch, ...(accepted ? {terms: status.terms} : {}), change: value});
  }
  assert.equal((await device(path, undefined, tokens.mcp)).status, 401);
  const visible = await (await device('/api/status')).json();
  assert.equal(visible.factorHistoryProtocol, 1);
  assert.equal((await device('/api/weather', {protocol: 1, epoch: visible.weatherEpoch, enabled: true, terms: WEATHER_TERMS})).status, 200);
  assert.equal((await getStatus()).sources.weather, false);
  const live = () => tool('get_weather_context', {mode: 'specified', place});
  await live();
  assert.equal((await tool('get_factor_history', query)).sources.weather.status, 'unavailable');
  const enable = {action: 'set', source: 'weather', enabled: true};
  assert.equal((await change(enable, false)).status, 400);
  assert.equal((await change(enable)).status, 200);
  now += 1000;
  await live();
  const firstKnowledge = iso(now);
  now += 1000; temperature = 25; await live();
  const readsBeforeHistory = calls;
  const earlier = (await tool('get_factor_history', {...query, known_at: firstKnowledge})).sources.weather;
  assert.deepEqual(earlier.entries.flatMap((entry: {forecast: {temperature_c: number}[]}) => entry.forecast.map(s => s.temperature_c)), [17]);
  assert.equal(earlier.entries[0].kind, 'model_forecast');
  const later = (await tool('get_factor_history', query)).sources.weather;
  assert.ok(JSON.stringify(later.entries).includes('"temperature_c":25'));
  assert.equal(calls, readsBeforeHistory);
  const receipt = later.response_context.arguments.archive_read_ids;
  const activity = {activity_id: 'afternoon/forecast-update', disposition: 'announce', text: 'A lighter layer should do for the afternoon.'};
  const sent = await tool('respond_to_context', {...activity, archive_read_ids: receipt});
  assert.equal(sent.stored_for_g2, true);
  assert.deepEqual(await tool('respond_to_context', {...activity, archive_read_ids: receipt}), sent);
  const reread = (await tool('get_factor_history', query)).sources.weather.response_context.arguments;
  assert.notDeepEqual(reread.archive_read_ids, receipt);
  assert.equal((await tool('respond_to_context', {...activity, ...reread})).data.reason, 'context_decision_conflict');
  assert.equal(bridge.outboundHistory().length, 1);
  assert.equal((await change({action: 'delete', source: 'weather'})).status, 200);
  assert.equal((await tool('get_factor_history', query)).sources.weather.status, 'unavailable');
  assert.equal((await tool('respond_to_context', {...activity, archive_read_ids: receipt})).data.reason, 'archive_context_unknown');
  await live();
  assert.equal(calls, readsBeforeHistory + 1);
  assert.deepEqual([rainReads, rainRefreshes], [0, 0]);

  assert.equal((await change(enable)).status, 200);
  const metOnly = await (await device('/api/status')).json();
  assert.equal(metOnly.satelliteEnabled, false);
  assert.equal((await device('/api/weather', {protocol:1, epoch:metOnly.weatherEpoch, enabled:true,
    terms:WEATHER_TERMS, satellite_terms:SATELLITE_TERMS})).status, 200);
  // The shared public file started acquisition before either current grant.
  rainRequested = now - 1; rainRetrieved = now + 1; now += 100;
  const fromEarlierAcquisition = await live();
  assert.equal(fromEarlierAcquisition.satellite_precipitation.data_kind, 'satellite_precipitation_rate_estimate');
  const rainQuery = {start_at: iso(frameStart), end_at: iso(frameStart + 60_000), fields: {weather:['satellite_precipitation']}};
  assert.equal((await tool('get_factor_history', rainQuery)).sources.weather.status, 'empty');

  rainRequested = now + 1; rainRetrieved = now + 2; now += 100; revision++;
  const shared = await tool('get_weather_context', {mode:'specified', place:{...place, latitude:11, label:'Requested pier'}});
  assert.equal(shared.evidence.data_kind, 'model_forecast');
  assert.equal(shared.satellite_precipitation.status, 'available');
  assert.equal(shared.satellite_precipitation.areas[0].peak_nominal_mm_h, 1.2);
  assert.deepEqual(shared.response_context.arguments.weather_read_ids, [shared.weather_read_id]);
  const providerCalls = [calls, rainReads, rainRefreshes];
  const enabled = await (await device('/api/status')).json();
  assert.equal((await device('/api/weather', {protocol:1, epoch:enabled.weatherEpoch, enabled:false})).status, 200);
  assert.ok((await tool('respond_to_context', {disposition:'silent', weather_read_ids:[shared.weather_read_id]})).data?.reason);
  const prior = (await tool('get_factor_history', {...rainQuery, known_at:iso(now - 1)})).sources.weather;
  assert.equal(prior.status, 'empty');
  const saved = (await tool('get_factor_history', rainQuery)).sources.weather;
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].available_at, iso(now));
  assert.equal(saved.entries[0].first_retrieved_at, iso(rainRetrieved));
  assert.deepEqual(saved.entries[0].satellite_precipitation.areas, shared.satellite_precipitation.areas);
  assert.doesNotMatch(JSON.stringify(saved.entries), /Requested pier|latitude|longitude/);
  const archiveOnly = {disposition:'silent', archive_read_ids:saved.response_context.arguments.archive_read_ids};
  assert.equal((await tool('respond_to_context', archiveOnly)).stored_for_g2, false);
  assert.equal((await change({action:'delete',source:'weather'})).status, 200);
  assert.equal((await tool('respond_to_context', archiveOnly)).data?.reason, 'archive_context_unknown');
  assert.deepEqual([calls, rainReads, rainRefreshes], providerCalls);
});
