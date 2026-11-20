import assert from 'node:assert/strict';
import test from 'node:test';
import { mobilityArchiveRecords, projectEnvironment, weatherArchiveRecords } from '../server/history/environment-fields.ts';
import type { ArchiveInput, ArchiveRecord } from '../server/history/archive-store.ts';
import { weatherEvidence } from '../server/weather/service.ts';
import type { WeatherForecast, WeatherSample } from '../server/weather/types.ts';

const start = Date.UTC(2026, 0, 1);
const hour = 3_600_000;
const iso = (n: number) => new Date(n).toISOString();
const point = {latitude: 0, longitude: 0};
const scope = {mode: 'specified' as const, place: {...point, label: 'Requested place', source: 'user_provided', reference: 'synthetic'}};
const stored = (r: ArchiveInput): ArchiveRecord => ({...r, period: '7d', expiresAtMs: start + 7 * 24 * hour});
function forecast(at: number, temperature: number, age: number, checkedAt = at) {
  const sample = (n: number): WeatherSample => ({
    valid_at: iso(n), temperature_c: temperature, humidity_percent: null, wind_m_s: 2, wind_from_degrees: 180,
    pressure_hpa: 1000, cloud_percent: 10,
    precipitation: [{from: iso(n), until: iso(n + 6 * hour), hours: 6, amount_mm: null, probability_percent: 50, symbol: null}],
  });
  const data: WeatherForecast = {provider:'met-norway-locationforecast-2', updated_at:iso(start),
    point, elevation_m:null, samples:[sample(start), sample(start + 40 * hour)]};
  return weatherEvidence(point, {key:'0'.repeat(64), retrievedAt:age, checkedAt, forecast:data,
    nextRequestAt:start + 3 * hour, deprecated:false, refreshFailed:false}, at);
}

test('historic forecasts retain edition, check, validity and knowledge times; period projections separate point and interval evidence', () => {
  const e = forecast(start + 10,21,start);
  const original = weatherArchiveRecords(e, scope, start + 10)[0];
  const row = stored(original);
  const select = (fields: string[], from: number, to: number) => projectEnvironment('weather',row,fields,{start:from,end:to}) as any;
  const temp = select(['temperature','humidity'], start, start + 1);
  assert.equal(temp.kind, 'model_forecast');
  assert.equal(temp.issued_at, iso(start)); assert.equal(temp.first_retrieved_at,iso(start));
  assert.equal(temp.available_at,iso(start + 10)); assert.equal(temp.checked_at,iso(start + 10));
  assert.deepEqual(temp.forecast,[{valid_at:iso(start),temperature_c:21,humidity_percent:null,apparent_temperature_c:null}]);
  assert.equal(temp.place, undefined); assert.ok(temp.source.attribution.includes('MET Norway'));
  const rain = select(['temperature','precipitation'], start + 2 * hour, start + 3 * hour);
  assert.equal(rain.forecast[0].temperature_c,undefined);
  assert.equal(rain.forecast[0].precipitation[0].from, iso(start));
  assert.equal(rain.forecast[0].precipitation[0].until,iso(start + 6 * hour));
  assert.equal(select(['temperature'],start + 2 * hour,start + 3 * hour),null);
  assert.equal(select(['precipitation'],start + 6 * hour,start + 7 * hour),null);
  assert.equal(select(['place'],start,start + 1).place.place.label,'Requested place');
  // The provider supplied this sample outside the live presentation's 36-hour lookahead.
  assert.equal(select(['temperature'],start + 40 * hour,start + 40 * hour + 1).forecast[0].temperature_c,21);
  assert.equal(weatherArchiveRecords(e,scope,start + 300)[0].id, original.id);
  const recheck = weatherArchiveRecords(forecast(start+100,21,start,start+100),scope,start+100)[0];
  const changed = weatherArchiveRecords(forecast(start+200,26,start+200),scope,start+200)[0];
  assert.equal((recheck.payload as any).revision,(row.payload as any).revision);
  assert.notEqual(recheck.id, original.id);
  assert.equal(recheck.anchorMs, original.anchorMs);
  assert.notEqual((changed.payload as any).revision,(row.payload as any).revision);
  assert.equal((changed.payload as any).issued_at, (row.payload as any).issued_at);
  assert.notEqual(weatherArchiveRecords(e,{mode:'current',location_measured_at:iso(start)},start+10)[0].id, original.id);
});

test('route archive separates plans, models, private coordinates and bounded reconstructable geometry/steps', () => {
  const secret = 'never-record-this-live-context';
  const geometry = 'A'.repeat(22_000);
  const destination = {latitude:1,longitude:1,source:'user_provided' as const,reference:'synthetic'};
  const input = {context_id:secret,destination,walking:true,terrain:true};
  const steps = Array.from({length:28}, (_,i) => ({name:'step '+i,mode:'walking',distance_m:30,estimated_seconds:80,
    maneuver:'turn',direction:null,position:point,ephemeral:secret}));
  const raw = {context_id:secret,origin:{...point,extra:secret},destination,requested_at:iso(start),retrieved_at:iso(start+1),
    status:'finished',limitations:['Estimate'],walking:{status:'available',endpoints:[{position:point,connector_access:'unknown'}],
    candidates:[{distance_m:900,estimated_seconds:800,contains_ferry:false,steps,omitted_steps:1,
      geometry:{format:'encoded_polyline',precision:5,value:geometry,omitted:false}}]},terrain:{status:'partial',model:'Terrarium',
    covered_segments:3, total_segments:4, ascent_m:null, steep_sections:[], omitted_steep_sections:null}};
  const rows = mobilityArchiveRecords(input,iso(start-20),raw,start+4).map(stored);
  assert(!JSON.stringify(rows).includes(secret));
  assert.deepEqual(rows.map(r=>r.id),mobilityArchiveRecords(input,iso(start-20),raw,start+100).map(r=>r.id));
  const window = {start,end:start+2};
  const project = (fields: string[]) => rows.map(r=>projectEnvironment('mobility',r,fields,window) as any).filter(Boolean);
  const plans = project(['plan','terrain']);
  assert.equal(plans.length,1); assert.equal(plans[0].kind,'planned_route_or_model_terrain');
  assert.equal(plans[0].terrain.ascent_m,null); assert.equal(plans[0].plan.candidates[0].distance_m,900);
  assert.equal(plans[0].endpoints,undefined);
  assert.equal(plans[0].attribution.walking.fix_map_url,'https://www.openstreetmap.org/fixthemap');
  assert.equal(project(['endpoints'])[0].endpoints.graph_endpoints[0].connector_access,'unknown');
  const pieces = project(['geometry']);
  assert.equal(pieces.length,3);
  assert(pieces.every(p=>Buffer.byteLength(JSON.stringify(p))<12*1024));
  assert.equal(pieces.map(p=>p.geometry.value).join(''),geometry);
  assert.deepEqual(project(['steps']).flatMap(p=>p.steps.values.map((s:any)=>s.name)),steps.map(s=>s.name));
  assert.equal(project(['steps'])[0].steps.omitted_steps,1);
  assert.equal(projectEnvironment('mobility',rows[0],['plan'],{start:start+2,end:start+3}),null);
  assert.deepEqual(mobilityArchiveRecords(input,iso(start),{status:'busy'},start),[]);
});
