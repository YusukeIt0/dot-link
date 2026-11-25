import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID, randomBytes} from 'node:crypto';
import {WeatherContext, SATELLITE_TERMS, WEATHER_TERMS} from '../server/weather/context.ts';
import {weatherSource, weatherQueryPoint, type WeatherEvidence, type WeatherPoint} from '../server/weather/types.ts';
import {LocationContext} from '../server/location.ts';
import {WebhookSender} from '../server/webhook.ts';
import {WeatherSharing} from '../src/weather-sharing.ts';
import type {CaptureEnvironment, EnvironmentWriter} from '../server/history/environment-fields.ts';
import type {ArchiveInput} from '../server/history/archive-store.ts';
import {ArchiveAuthority} from '../server/history/archive-authority.ts';
import {EnvironmentHistory} from '../server/history/environment-history.ts';
import {WeatherService} from '../server/weather/service.ts';
import {WeatherCache} from '../server/weather/cache.ts';
import {Bridge} from '../server/bridge.ts';
import {ContextResponder} from '../server/context-response.ts';
import {rainFrame} from './fixtures/rain-rate.ts';
import type {NearbyRainRead, RainRateService} from '../server/weather/rain-rate/service.ts';
const owner='a'.repeat(64);
const flush=()=>new Promise<void>(r=>setImmediate(r));
type RainBackend = Pick<RainRateService,'read'|'refresh'|'cancel'|'close'>;
function fixture(t:TestContext, archive?:CaptureEnvironment, options: {satellite?:RainBackend; automatic?:boolean} = {}) {
 const dir=mkdtempSync(join(tmpdir(),'weather-context-'));let now=Date.parse('2026-11-10T09:20:00Z');let authorized=true;
 const events:unknown[]=[];
 const sender=new WebhookSender(async (_url,raw)=>{const e=JSON.parse(raw);if(e.type==='verification')return {status:200,body:JSON.stringify({challenge:e.challenge})};events.push(e);return {status:202,body:'{}'};});
 const location=new LocationContext(join(dir,'location.json'),sender,['callback.example.test'],async (_input,guard)=>{guard();return {stored_for_g2:true};},()=>now,()=>authorized);
 const sharing=randomUUID();let seq=0,calls=0,temp=20,humidity=70;
 let load:undefined|((point:WeatherPoint,signal:AbortSignal)=>Promise<WeatherEvidence>);
 const evidence=(point:WeatherPoint):WeatherEvidence=>({status:'ready',source:weatherSource,data_kind:'model_forecast',query_point:weatherQueryPoint(point),as_of:new Date(now).toISOString(),retrieved_at:new Date(now).toISOString(),checked_at:new Date(now).toISOString(),updated_at:'2026-11-10T09:00:00Z',retry_at:null,elevation_m:0,apparent_temperature_c:null,limitations:[],forecast:[],current:{valid_at:'2026-11-10T09:00:00Z',temperature_c:temp,humidity_percent:humidity,wind_m_s:1,wind_from_degrees:0,pressure_hpa:1000,cloud_percent:20,precipitation:[]}});
 const service={query:async (p:WeatherPoint,s:AbortSignal,g:()=>void)=>{calls++;g();return load?load(p,s):evidence(p);},cancel(){},close(){}};
 const create=()=>new WeatherContext(join(dir,'consent.json'),service,location,{ownerAuthorized:()=>authorized,now:()=>now,automatic:false,archive,...options});
 const weather=create();t.after(()=>{weather.close();location.close();rmSync(dir,{recursive:true,force:true});});
 const consent=(enabled=true,rain=false)=>weather.control({protocol:1,epoch:weather.status(owner).weatherEpoch,enabled,...(enabled?{terms:WEATHER_TERMS}:{}),...(rain?{satellite_terms:SATELLITE_TERMS}:{})},owner);
 const update=(latitude=10)=>location.update({sharing_id:sharing,sequence:++seq,fix:{latitude,longitude:20,accuracy:5,measured_at:new Date(now).toISOString()}},owner);
 const enable=()=>location.control({sharing_id:sharing,enabled:true},owner);
 const subscribe=()=>location.subscribe({name:'location.updated',arguments:{session_id:'personal-g2'},delivery:{mode:'webhook',url:'https://callback.example.test/location',secret:'whsec_'+randomBytes(32).toString('base64')}});
 return {weather,location,events,consent,update,enable,subscribe,create,evidence,dir,sender,now:()=>now,calls:()=>calls,setLoad:(f:typeof load)=>{load=f;},setValues:(a:number,b:number)=>{temp=a;humidity=b;},advance:(ms:number)=>{now+=ms;},revoke:()=>{authorized=false;},stop:()=>location.control({sharing_id:sharing,enabled:false},owner)};
}
const specified={mode:'specified',place:{latitude:35.68,longitude:139.76,label:'Tokyo public fixture',source:'user_provided',reference:'Explicit test request'}};
test('weather consent is independent, default off, terms and current epochs are mandatory',async t=>{
 const f=fixture(t);f.enable();f.update();await assert.rejects(f.weather.read({mode:'current'}),/not enabled/);assert.equal(f.calls(),0);
 const epoch=f.weather.status(owner).weatherEpoch;
 assert.throws(()=>f.weather.control({protocol:1,epoch,enabled:true},owner));
 f.consent();await f.weather.read({mode:'current'});
 assert.throws(()=>f.weather.control({protocol:1,epoch,enabled:false},owner));
 assert.equal(f.weather.status('b'.repeat(64)).weatherEnabled,false);
 f.consent(false);await assert.rejects(f.weather.read(specified));
});
test('specified places work with location off and never become current location',async t=>{
 const f=fixture(t);f.consent();const r=await f.weather.read(specified);assert.equal(r.mode,'specified');assert.equal(f.location.read().context,null);
 await assert.rejects(f.weather.read({mode:'current'}));await assert.rejects(f.weather.read({mode:'specified',place:{latitude:0,longitude:0}}));
});

test('weather archive captures only eligible acquisitions while specified and automatic current reads remain independent', async t => {
 let writer: EnvironmentWriter | undefined;
 const rows:ArchiveInput[] = [];
 const f = fixture(t, id => { assert.equal(id, owner); return writer; });
 f.consent();
 const original = (await f.weather.read(specified)).evidence;
 assert.equal(rows.length, 0);
 const since = Date.parse(original.as_of);
 writer = Object.assign((row:ArchiveInput) => { rows.push(row); }, {since});
 f.advance(1);
 f.setLoad(async () => original);
 assert.equal((await f.weather.read(specified)).evidence, original);
 assert.equal(rows.length, 0, 'a cached edition delivered before enrollment stays live-only');
 f.setLoad(undefined);
 await f.weather.read(specified);
 assert.equal((rows[0].payload as any).scope.mode, 'specified');
 f.enable(); f.update(); await f.subscribe(); await f.weather.refresh();
 assert.equal((rows.at(-1)!.payload as any).scope.mode, 'current');
 const count = rows.length;
 writer = Object.assign(() => { throw new Error('storage unavailable'); }, {since});
 assert.equal((await f.weather.read(specified)).evidence.status, 'ready');
 assert.equal(rows.length, count);
});

test('a legacy recheck after weather history deletion stays live-only until a provably new edition arrives', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weather-history-rollback-'));
  const morning = Date.parse('2026-11-10T09:00:00Z'), hour = 3_600_000;
  const iso = (time: number) => new Date(time).toISOString();
  let now = morning - 1;
  const key = randomBytes(32);
  const authority = new ArchiveAuthority(join(directory, 'history'), {
    async create() { return {key: Buffer.from(key), wrapped: 'synthetic-key'}; },
    async open() { return Buffer.from(key); },
  }, {now: () => now, ownerStatus: id => id === owner ? 'authorized' : 'revoked'});
  const history = new EnvironmentHistory(authority, () => now);
  t.after(() => {authority.close(); key.fill(0); rmSync(directory, {recursive:true, force:true});});
  const control = async (action: 'enable' | 'delete') => authority.control(owner, (await authority.status(owner)).epoch,
    action === 'enable' ? {action:'set', source:'weather', enabled:true} : {action:'delete', source:'weather'});
  await control('enable');
  now = morning + hour;
  await control('delete');
  await control('enable');

  // A legacy client received the 09:00 edition again at noon and replaced retrievedAt.
  now = morning + 3 * hour;
  const point = weatherQueryPoint(specified.place);
  const path = join(directory,'weather.json');
  const f = fixture(t, id => history.capture(id, 'weather'));
  const forecast = {provider:'met-norway-locationforecast-2' as const, point, elevation_m:0, updated_at:iso(morning),
    samples:[3, 6, 7].map(h => ({...f.evidence(point).current!, valid_at:iso(morning + h * hour), temperature_c:21}))};
  const oldKey = createHash('sha256').update(JSON.stringify([forecast.provider, point])).digest('hex');
  writeFileSync(path, JSON.stringify({version:1, nextRequestAt:now + 60_000, entries:[{
    key:oldKey, nextRequestAt:now + 3 * hour, retrievedAt:now, checkedAt:now, deprecated:false, refreshFailed:false, forecast,
  }]}));
  let calls = 0;
  const service = new WeatherService(path, {cache:new WeatherCache(path, () => now), now:() => now, random:() => 0,
    provider:{id:forecast.provider, load:async () => {
      calls++;
      return {notModified:false, deprecated:false, forecast:{...forecast, edition:'b'.repeat(64),
        samples:forecast.samples.map(sample => ({...sample, temperature_c:25}))}};
    }}});
  t.after(() => service.close());
  f.setLoad((p, signal) => service.query(p, signal, () => {}));
  f.advance(now - Date.parse(f.evidence(point).as_of));
  f.consent();
  const period = {start_at:iso(morning + 7 * hour), end_at:iso(morning + 7 * hour + 1), fields:['temperature'], limit:10};
  const reader = history.reader('weather');
  const cached = (await f.weather.read(specified)).evidence;
  assert.equal(cached.current?.temperature_c, 21);
  assert.equal(cached.retrieved_at, iso(now));
  assert.equal(calls, 0);
  assert.equal(reader.readSelectedHistory(period).status, 'empty');

  now += 3 * hour + 1;
  f.advance(3 * hour + 1);
  const revised = (await f.weather.read(specified)).evidence;
  assert.equal(revised.current?.temperature_c, 25);
  assert.equal(calls, 1);
  assert.equal(reader.readSelectedHistory({...period, known_at:iso(now - 1)}).status, 'empty');
  const page = reader.readSelectedHistory({...period, known_at:iso(now)});
  assert.equal(page.status, 'available');
  assert.equal(page.entries.length, 1);
  assert.equal((page.entries[0] as {forecast:{temperature_c:number}[]}).forecast[0].temperature_c, 25);
});

test('enrolling during a coalesced weather request does not archive the earlier acquisition', async t => {
 let writer:EnvironmentWriter | undefined;
 const rows:ArchiveInput[] = [];
 const f = fixture(t, () => writer);
 f.consent();
 let finish!:(e:WeatherEvidence)=>void;
 f.setLoad(() => new Promise(r => { finish=r; }));
 const first=f.weather.read(specified);
 await flush(); f.advance(1);
 writer=Object.assign((row:ArchiveInput)=>{rows.push(row);}, {since:Date.parse(f.evidence(specified.place).as_of)});
 const second=f.weather.read(specified);
 f.advance(1); finish(f.evidence(specified.place));
 assert.equal((await first).evidence.status,'ready');
 assert.equal((await second).evidence.status,'ready');
 assert.equal(f.calls(),1); assert.equal(rows.length,0);
 f.setLoad(undefined); await f.weather.read(specified);
 assert.ok(rows.length);
});
test('temperature and humidity changes create new decisions after silence, identical evidence does not',async t=>{
 const f=fixture(t);f.enable();f.update();f.consent();await f.weather.read({mode:'current'});await f.subscribe();await flush();
 const initial=f.location.read().context!;await f.location.respond({context_id:initial.context_id,disposition:'silent'});
 const id=f.location.read().context!.context_id;await f.weather.read({mode:'current'});assert.equal(f.location.read().context!.context_id,id);
 f.advance(31_000);f.update();f.setValues(30,90);await f.weather.refresh();await flush();
 const next=f.location.read().context!;assert.equal(next.weather!.current!.temperature_c,30);assert.equal(next.weather!.current!.humidity_percent,90);
 assert.notEqual(next.context_id,id);assert.equal(f.events.length,2);
 await f.location.respond({context_id:next.context_id,disposition:'silent'});
});
test('same-region new phone fixes preserve weather; moving never retains old-region evidence',async t=>{
 const f=fixture(t);f.enable();f.update();f.consent();await f.weather.read({mode:'current'});
 f.update(10.0001);assert.equal(f.location.read().context!.weather!.current!.temperature_c,20);
 f.update(11);assert.equal(f.location.read().context!.weather,undefined);await f.weather.read({mode:'current'});
 assert.equal(f.location.read().context!.weather!.query_point.latitude,11);
});
test('moving while a request is pending rejects the old-region result',async t=>{
 const f=fixture(t);f.enable();f.update();f.consent();await flush();let finish!:(e:WeatherEvidence)=>void;
 f.setLoad(()=>new Promise(r=>{finish=r;}));const pending=f.weather.read({mode:'current'});await flush();f.update(11);finish(f.evidence({latitude:10,longitude:20}));
 await assert.rejects(pending);assert.equal(f.location.read().context!.weather,undefined);
});
test('weather revocation rejects late current and specified results and old weather decisions',async t=>{
 const f=fixture(t);f.enable();f.update();f.consent();await f.weather.read({mode:'current'});const id=f.location.read().context!.context_id;
 let finish!:(e:WeatherEvidence)=>void;f.setLoad(()=>new Promise(r=>{finish=r;}));const pending=f.weather.read(specified);await flush();f.consent(false);finish(f.evidence(specified.place));
 await assert.rejects(pending);assert.equal(f.location.read().context!.weather,undefined);
 await assert.rejects(f.location.respond({context_id:id,disposition:'announce',text:'Old weather'}));
 const fresh=f.location.read().context!;await f.location.respond({context_id:fresh.context_id,disposition:'announce',text:'Conversation continues'});
});
test('stopped, expired or revoked current location is unusable; specified-place access is separate',async t=>{
 const f=fixture(t);f.enable();f.update();f.consent();f.advance(100_000);await assert.rejects(f.weather.read({mode:'current'}));
 await f.weather.read(specified);f.stop();await assert.rejects(f.weather.read({mode:'current'}));f.revoke();await assert.rejects(f.weather.read(specified));
});
test('restart preserves separate consent but changes its control epoch',async t=>{
 const f=fixture(t);f.consent();const epoch=f.weather.status(owner).weatherEpoch;f.weather.close();const next=f.create();t.after(()=>next.close());
 assert.equal(next.status(owner).weatherEnabled,true);assert.notEqual(next.status(owner).weatherEpoch,epoch);await assert.rejects(next.read({mode:'current'}));
});
test('failed acquisition does not block location reads or normal decisions',async t=>{
 const f=fixture(t);f.enable();f.update();f.consent();await flush();f.setLoad(async()=>{throw Error('fixture outage');});
 await assert.rejects(f.weather.read({mode:'current'}));const read=f.location.read().context!;assert.ok(read);await f.location.respond({context_id:read.context_id,disposition:'silent'});
});
test('phone consent does not migrate across Mac targets and failed changes stay unconfirmed',async()=>{
 let target='one',now=0;const requests:unknown[]=[];
 const ui=new WeatherSharing({target:()=>target,now:()=>now,changed(){},api:async p=>{requests.push(p);throw Error('offline');}});
 ui.receive({weatherProtocol:1,weatherEpoch:randomUUID(),weatherTerms:WEATHER_TERMS,weatherEnabled:false});await ui.control(true);assert.equal(ui.status().failed,true);assert.equal(ui.status().weatherEnabled,false);
 target='two';assert.equal(ui.status().supported,false);await ui.control(true);assert.equal(requests.length,1);
 target='one';now=46_000;assert.equal(ui.status().supported,false);
 ui.reset();assert.equal(ui.status().supported,false);
 ui.receive({weatherProtocol:1,weatherEpoch:randomUUID(),weatherTerms:WEATHER_TERMS,weatherEnabled:true});
 assert.equal(ui.status().failed,false);assert.equal(ui.status().supported,true);assert.equal(ui.status().weatherEnabled,true);
 assert.equal(requests.length,1,'reconnecting confirms server state without another toggle request');
});

test('clock advancement changes cached temperature and humidity without another provider request',async t=>{
 const {WeatherService}=await import('../server/weather/service.ts');
 const f=fixture(t);f.weather.close();const dir=mkdtempSync(join(tmpdir(),'weather-clock-'));let now=Date.parse('2026-11-10T09:20:00Z'),calls=0;
 const service=new WeatherService(join(dir,'cache.json'),{now:()=>now,random:()=>0,provider:{id:'met-norway-locationforecast-2',load:async point=>{
  calls++;return {notModified:false,deprecated:false,forecast:{provider:'met-norway-locationforecast-2',point,updated_at:'2026-11-10T09:00:00Z',elevation_m:0,
   samples:[0,1,2].map(i=>({valid_at:`2026-11-10T${String(9+i).padStart(2,'0')}:00:00Z`,temperature_c:20+i*5,humidity_percent:70+i*10,wind_m_s:1,wind_from_degrees:0,pressure_hpa:1000,cloud_percent:20,precipitation:[]}))}};
 }}});
 const weather=new WeatherContext(join(dir,'consent.json'),service,f.location,{now:()=>now,ownerAuthorized:()=>true,automatic:false});
 t.after(()=>{weather.close();rmSync(dir,{recursive:true,force:true});});
 f.enable();f.update();await f.subscribe();weather.control({protocol:1,epoch:weather.status(owner).weatherEpoch,enabled:true,terms:WEATHER_TERMS},owner);
 const first=await weather.read({mode:'current'});assert.equal(first.evidence.current!.temperature_c,20);
 const id=f.location.read().context!.context_id;await f.location.respond({context_id:id,disposition:'silent'});
 now+=3_600_000;f.advance(3_600_000);f.enable();f.update();await f.subscribe();await weather.refresh();
 const next=f.location.read().context!;assert.equal(next.weather!.current!.temperature_c,25);assert.equal(next.weather!.current!.humidity_percent,80);assert.equal(calls,1);
});

test('automatic checks require subscription and coalesce concurrent same-cell readers',async t=>{
 const f=fixture(t);f.enable();f.update();f.consent();await f.weather.refresh();assert.equal(f.calls(),0);
 let finish!:(value:WeatherEvidence)=>void;f.setLoad(()=>new Promise(r=>{finish=r;}));
 const first=f.weather.read({mode:'current'}),second=f.weather.read({mode:'current'});await flush();assert.equal(f.calls(),1);
 finish(f.evidence({latitude:10,longitude:20}));const values=await Promise.all([first,second]);assert.equal(values[0].evidence.current!.temperature_c,20);assert.deepEqual(values[0].evidence,values[1].evidence);
});

test('stopping current sharing during acquisition rejects late data while location remains absent',async t=>{
 const f=fixture(t);f.enable();f.update();f.consent();let finish!:(e:WeatherEvidence)=>void;
 f.setLoad(()=>new Promise(r=>{finish=r;}));const pending=f.weather.read({mode:'current'});await flush();f.stop();finish(f.evidence({latitude:10,longitude:20}));
 await assert.rejects(pending);assert.equal(f.location.read().context,null);
});

test('an outage after moving cannot reuse previous-region weather as current',async t=>{
 const f=fixture(t);f.enable();f.update();f.consent();await f.weather.read({mode:'current'});f.update(11);
 f.setLoad(async()=>{throw Error('Destination outage');});await assert.rejects(f.weather.read({mode:'current'}));
 const context=f.location.read().context!;assert.equal(context.latitude,11);assert.equal(context.weather,undefined);
 await f.location.respond({context_id:context.context_id,disposition:'silent'});
});

test('removing the old pairing permits a new owner to choose fresh consent, never inherit it',async t=>{
 const f=fixture(t);f.weather.close();const dir=mkdtempSync(join(tmpdir(),'weather-owner-'));let revoked=false;
 const service={query:async(p:WeatherPoint)=>f.evidence(p),cancel(){},close(){}};
 const weather=new WeatherContext(join(dir,'consent.json'),service,f.location,{ownerAuthorized:id=>id!==owner||!revoked,ownerRevoked:id=>id===owner&&revoked,automatic:false});
 t.after(()=>{weather.close();rmSync(dir,{recursive:true,force:true});});
 weather.control({protocol:1,epoch:weather.status(owner).weatherEpoch,enabled:true,terms:WEATHER_TERMS},owner);
 revoked=true;const other='b'.repeat(64),status=weather.status(other);assert.equal(status.weatherEnabled,false);assert.ok(status.weatherEpoch);
 weather.control({protocol:1,epoch:status.weatherEpoch,enabled:true,terms:WEATHER_TERMS},other);assert.equal(weather.status(other).weatherEnabled,true);
});

const frameAt = (hour: number, minute: number) => Date.UTC(2026, 10, 10, hour, minute);
function rainProvider(read: RainBackend['read'], refresh: RainBackend['refresh'] = async () => 'cached'): RainBackend {
  return {read, refresh, cancel() {}, close() {}};
}
function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => {release = resolve;});
  return {release, promise};
}

for (const change of ['move', 'location off', 'owner replacement'] as const) {
  test('a cold satellite download lets MET finish and loses access on ' + change, async t => {
    const download = barrier<'updated'>();
    const started = barrier<AbortSignal>();
    const rows: ArchiveInput[] = [];
    let reads = 0;
    const backend = rainProvider(async point => {
      reads++;
      return reads === 1 ? [] : [rainFrame(point, frameAt(9, 0), frameAt(9, 20) + 1, frameAt(9, 20) + 2, 1)];
    }, signal => {started.release(signal); return download.promise;});
    const f = fixture(t, () => Object.assign((row: ArchiveInput) => {rows.push(row);}, {since:frameAt(9, 20)}), {satellite:backend});
    f.enable(); f.update(); f.consent(true, true); f.advance(10);
    const pending = f.weather.read({mode:'current'});
    const signal = await started.promise;
    const met = await pending; // The network response is still deliberately held.
    assert.equal(met.evidence.current?.temperature_c, 20);
    assert.equal(met.satellite_precipitation?.status, 'temporarily_unavailable');
    assert.equal(signal.aborted, false);
    if (change === 'move') f.update(11);
    if (change === 'location off') f.stop();
    if (change === 'owner replacement') {
      f.weather.revokeOwner(owner);
      const nextOwner = 'b'.repeat(64);
      const state = f.weather.status(nextOwner);
      assert.equal(state.satelliteEnabled, false);
      f.weather.control({protocol:1, epoch:state.weatherEpoch, enabled:true, terms:WEATHER_TERMS}, nextOwner);
      assert.equal((await f.weather.read(specified)).satellite_precipitation, undefined);
    }
    assert.equal(signal.aborted, true);
    download.release('updated'); await flush();
    assert.equal(reads, 1);
    assert.ok(rows.every(row => !row.id.startsWith('weather:satellite:')));
    assert.throws(() => f.weather.responseContext(met.weather_read_id).guard());
  });
}

test('a slow local decode lets MET return first, then reports missing directional coverage when the satellite estimate is ready', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const local = barrier<NearbyRainRead[]>();
  const f = fixture(t, undefined, {satellite:rainProvider(() => local.promise)});
  f.consent(true, true); f.advance(10);
  const pending = f.weather.read(specified);
  t.mock.timers.tick(1000);
  const met = await pending;
  assert.equal(met.evidence.current?.temperature_c, 20);
  assert.equal(met.satellite_precipitation?.status, 'temporarily_unavailable');
  assert.equal(f.location.read().context, null);
  const data = rainFrame(specified.place, frameAt(9, 0), f.now() - 5, f.now() - 4, 1);
  data.sample.status = 'partial';
  const east = data.sample.areas.find(area => area.area === 'E')!;
  Object.assign(east, {nominal:0, wet_nominal:0, missing_or_bad:east.cells, peak_nominal_mm_h:null});
  local.release([data]); await flush();
  const known = (await f.weather.read(specified)).satellite_precipitation;
  assert.ok(known && 'areas' in known);
  assert.equal(known.status, 'partial');
  assert.deepEqual(known.areas.find(area => area.area === 'E'), east);
  assert.equal(known.areas.find(area => area.area === 'W')!.peak_nominal_mm_h, 1.2);
  assert.equal(f.location.read().context, null);
  const outside = await f.weather.read({...specified, place:{...specified.place, latitude:75}});
  assert.equal(outside.satellite_precipitation?.status, 'outside_extent');
});

for (const compare of [false, true]) {
  test('a queued weather answer is rejected at the expiry of ' + (compare ? 'the earlier compared frame' : 'its satellite frame'), async t => {
    const old = frameAt(8, 30), newer = frameAt(8, 40);
    const f = fixture(t, undefined, {satellite:rainProvider(async (point, _signal, options) => {
      const read = (start: number, revision: number) => rainFrame(point, start, frameAt(9, 19), frameAt(9, 19) + 1, revision);
      return options?.previous ? [read(newer, 2), read(old, 1)] : [read(compare ? newer : old, 1)];
    })});
    f.consent(true, true);
    const result = await f.weather.read({...specified, ...(compare ? {nearby_precipitation:true} : {})});
    const satellite = result.satellite_precipitation;
    assert.ok(satellite && 'areas' in satellite);
    assert.equal(!!satellite.comparison, compare);
    const expiry = frameAt(9, 24); // The earlier 08:39 embedded end plus 45 minutes.
    assert.equal(result.response_context.expires_no_later_than, new Date(expiry).toISOString());
    const forecastOnly = result.forecast_only_response_context;
    assert.ok(forecastOnly);
    const forecastExpiry = f.now() + 5 * 60_000;
    assert.equal(forecastOnly.expires_no_later_than, new Date(forecastExpiry).toISOString());
    const bridge = new Bridge(join(f.dir,'weather-answer.json'), f.sender, []);
    t.after(() => bridge.close());
    const queue = barrier<void>(), admitted = barrier<void>();
    const responder = new ContextResponder(async (input, guard, location) => {
      admitted.release(); await queue.promise; return bridge.sendMessage(input, guard, location);
    });
    const message = {disposition:'announce', weather_read_ids:[result.weather_read_id], text:'A fixture answer'};
    const sending = responder.respond(message, {weather:f.weather});
    await admitted.promise;
    f.advance(expiry - f.now() - 1);
    assert.ok(f.weather.responseContext(result.weather_read_id).guard());
    f.advance(1); queue.release();
    await assert.rejects(sending, {reason:'weather_context_expired'});
    const forecastGuard = f.weather.responseContext(forecastOnly.arguments.weather_read_ids[0]).guard;
    assert.equal(forecastGuard(), true);
    assert.equal(bridge.outboundHistory().length, 0);
    if (compare) {
      const remaining = (await f.weather.read(specified)).satellite_precipitation;
      assert.ok(remaining && 'areas' in remaining);
      assert.equal(remaining.edition, satellite.edition);
      assert.equal(remaining.comparison, undefined);
    }
    f.advance(forecastExpiry - f.now());
    assert.throws(forecastGuard, {reason:'weather_context_expired'});
  });
}

test('the passive timer checks existing MET weather and a completed satellite read creates no extra location event', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  let reads = 0, refreshes = 0;
  const f = fixture(t, undefined, {automatic:true, satellite:rainProvider(async point => {
    reads++; return [rainFrame(point, frameAt(9,0), frameAt(9,20) + 1, frameAt(9,20) + 2, 1)];
  }, async () => {refreshes++; return 'cached';})});
  f.enable(); f.update(); await f.subscribe();
  const met = f.evidence({latitude:10,longitude:20});
  f.setLoad(async () => met);
  f.consent(true, true); await flush();
  const context = f.location.read().context!;
  await f.location.respond({context_id:context.context_id, disposition:'silent'});
  const eventCount = f.events.length, metCalls = f.calls();
  f.advance(61_000); t.mock.timers.tick(61_000); await flush();
  assert.ok(f.calls() > metCalls);
  assert.deepEqual([reads,refreshes], [0,0]);
  const result = await f.weather.read({mode:'current'}); await flush();
  assert.equal(result.satellite_precipitation?.status, 'available');
  assert.deepEqual([reads,refreshes], [1,1]);
  assert.equal(f.events.length, eventCount);
  assert.equal(f.location.read().context!.context_id, context.context_id);
  assert.equal(f.location.read().context!.weather, met);
});

test('adding nearby rain to active MET preserves its accepted location decision, forecast receipt and in-flight read', async t => {
  let reads = 0, refreshes = 0;
  const f = fixture(t, undefined, {automatic:true, satellite:rainProvider(async point => {
    reads++; return [rainFrame(point, frameAt(9, 0), frameAt(9, 20), frameAt(9, 20) + 1, 1)];
  },
    async () => {refreshes++; return 'unavailable';})});
  f.enable(); f.update(); await f.subscribe();
  const forecast = f.evidence({latitude:10, longitude:20});
  f.setLoad(async () => forecast);
  f.consent(); await flush();
  const original = await f.weather.read({mode:'current'});
  const location = f.location.read().context!;
  await f.location.respond({context_id:location.context_id, disposition:'silent'});
  const decision = f.location.read().context!;
  const events = f.events.length;
  f.advance(31_000);
  const hold = barrier<WeatherEvidence>();
  f.setLoad(() => hold.promise);
  const pending = f.weather.read({mode:'current'});
  const before = f.calls(), oldControl = f.weather.status(owner).weatherEpoch;
  const granted = f.consent(true, true);
  hold.release(forecast);
  assert.equal((await pending).evidence, forecast);
  await flush();
  assert.equal(granted.satelliteEnabled, true);
  assert.notEqual(granted.weatherEpoch, oldControl);
  assert.throws(() => f.weather.control({protocol:1, epoch:oldControl, enabled:false}, owner));
  assert.equal(f.weather.responseContext(original.weather_read_id).guard(), true);
  assert.equal(f.location.read().context!.context_id, decision.context_id);
  assert.equal(f.location.read().context!.weather, forecast);
  assert.equal(f.calls(), before);
  assert.equal(f.events.length, events);
  assert.deepEqual([reads, refreshes], [0, 0]);
  const combined = await f.weather.read(specified);
  assert.equal(combined.satellite_precipitation?.status, 'available');
  // A legacy MET-only save removes NOAA. A same-clock regrant and re-read
  // cannot revive the prior supplemental receipt, even for the same public file.
  f.consent();
  assert.equal(f.weather.status(owner).satelliteEnabled, false);
  f.consent(true, true); await f.weather.read(specified);
  assert.throws(() => f.weather.responseContext(combined.weather_read_id).guard());
  assert.equal(f.weather.responseContext(original.weather_read_id).guard(), true);
  f.consent(false);
  assert.throws(() => f.weather.responseContext(original.weather_read_id).guard());
});

test('first local availability is distinct for one frame and a later comparison of an exact pair', async t => {
  const currentStart = frameAt(9, 10), previousStart = frameAt(9, 0);
  let revision = 1, previousRevision = 2, refreshes = 0;
  const f = fixture(t, undefined, {satellite:rainProvider(async (point, _signal, options) => {
    const read = (at: number, version: number) => rainFrame(point, at, frameAt(9,22), frameAt(9,22) + 1, version);
    return options?.previous ? [read(currentStart, revision), read(previousStart, previousRevision)] : [read(currentStart, revision)];
  }, async () => ++refreshes === 1 ? 'cached' : 'updated')});
  f.consent(true, true); f.advance(122_000);
  const selected = async (compare: boolean) => {
    const value = (await f.weather.read({...specified, ...(compare ? {nearby_precipitation:true} : {})})).satellite_precipitation;
    assert.ok(value && 'areas' in value);
    return value;
  };
  const one = await selected(false), firstFrameAt = one.available_at;
  assert.equal(one.comparison, undefined);
  f.advance(60_000);
  const firstComparisonAt = new Date(f.now()).toISOString();
  const pair = await selected(true);
  assert.equal(pair.available_at, firstFrameAt);
  assert.equal(pair.comparison?.available_at, firstComparisonAt);
  f.advance(-30_000);
  assert.equal((await selected(true)).comparison, undefined);
  f.advance(30_000);
  f.advance(60_000);
  assert.equal((await selected(false)).comparison, undefined);
  assert.equal((await selected(true)).comparison?.available_at, firstComparisonAt);
  // A same-object repair revalidates both local samples. The clocks stay attached
  // to their immutable identities. A different comparison or current frame gets a new clock.
  f.advance(8 * 60_000);
  await selected(true); await flush();
  assert.equal((await selected(true)).comparison?.available_at, firstComparisonAt);
  f.advance(10 * 60_000); previousRevision++;
  await selected(true); await flush();
  const revisedPair = await selected(true);
  assert.equal(revisedPair.available_at, firstFrameAt);
  assert.equal(revisedPair.comparison?.available_at, new Date(f.now()).toISOString());
  f.advance(10 * 60_000); revision++;
  await selected(true); await flush();
  const revisedCurrent = await selected(true);
  assert.equal(revisedCurrent.available_at, new Date(f.now()).toISOString());
});

for (const mode of ['current', 'specified'] as const) {
  test('a background satellite promotion preserves a queued MET-only reply from one ' + mode + ' read', async t => {
    const started = barrier<void>(), promotion = barrier<'updated'>();
    let refreshes = 0, latest = 1;
    const backend = rainProvider(async point => [rainFrame(point, frameAt(9, latest === 1 ? 0 : 10), frameAt(9,22), frameAt(9,22) + 1, latest)],
      async () => {
        if (++refreshes === 1) return 'cached';
        started.release();
        const updated = await promotion.promise;
        latest = 2; return updated;
      });
    const f = fixture(t, undefined, {satellite:backend});
    if (mode === 'current') {f.enable(); f.update();}
    f.consent(true, true); f.advance(122_000);
    if (mode === 'current') f.update();
    const request = mode === 'current' ? {mode} : specified;
    const first = await f.weather.read(request); await flush();
    f.advance(10 * 60_000);
    if (mode === 'current') f.update();
    const read = await f.weather.read(request);
    await started.promise;
    assert.ok(first.satellite_precipitation && 'edition' in first.satellite_precipitation);
    assert.ok(read.satellite_precipitation && 'edition' in read.satellite_precipitation);
    assert.equal(read.satellite_precipitation.edition, first.satellite_precipitation.edition);
    const calls = f.calls(), queue = barrier<void>(), admitted = barrier<void>();
    const bridge = new Bridge(join(f.dir, 'forecast-only.json'), f.sender, []);
    t.after(() => bridge.close());
    const responder = new ContextResponder(async (input, guard, location) => {
      admitted.release(); await queue.promise; return bridge.sendMessage(input, guard, location);
    });
    const sources = {weather:f.weather, locations:f.location};
    const answer = {disposition:'announce', text:'The forecast temperature is 20 °C.'};
    const forecast = read.forecast_only_response_context ?? read.response_context;
    const pending = responder.respond({...forecast.arguments, ...answer}, sources);
    await admitted.promise;
    promotion.release('updated'); await flush();
    queue.release(); const sent = await pending;
    assert.deepEqual(await responder.respond({...forecast.arguments, ...answer}, sources), sent);
    await assert.rejects(responder.respond({...read.response_context.arguments, ...answer}, sources), {reason:'weather_context_expired'});
    assert.equal(bridge.outboundHistory().length, 1);
    assert.equal(f.calls(), calls); assert.equal(refreshes, 2);
    if (mode === 'current') {
      assert.ok('context_id' in read && read.context_id);
      assert.equal(forecast.arguments.context_id, read.context_id);
      f.update(11);
    } else f.consent(false);
    await assert.rejects(responder.respond({...forecast.arguments, ...answer}, sources));
  });
}

test('using the strict and forecast-only mappings for one specified weather read cannot deliver two decisions', async t => {
  const f = fixture(t, undefined, {satellite:rainProvider(async point => [rainFrame(point, frameAt(9,0), frameAt(9,18), frameAt(9,19), 1)])});
  f.consent(true, true);
  const r = await f.weather.read(specified);
  assert.ok(r.forecast_only_response_context);
  const bridge = new Bridge(join(f.dir,'weather-idempotency.json'), f.sender, []);
  t.after(() => bridge.close());
  const responder = new ContextResponder(bridge.sendMessage.bind(bridge));
  const sources = {weather:f.weather};
  const answer = {disposition:'announce', text:'The forecast is 20 °C.'};
  const first = await responder.respond({...r.response_context.arguments, ...answer}, sources);
  const retry = await responder.respond({...r.forecast_only_response_context.arguments, ...answer}, sources);
  assert.deepEqual(retry, first);
  assert.equal(bridge.outboundHistory().length, 1);
  await assert.rejects(responder.respond({...r.forecast_only_response_context.arguments, ...answer, text:'A second statement'}, sources),
    {reason:'context_decision_conflict'});
  const metOnly = await f.weather.read({...specified, nearby_precipitation:false});
  assert.equal(metOnly.forecast_only_response_context, undefined);
  const withRain = f.weather.responseContext(r.weather_read_id).recallAllowed;
  const onlyForecast = f.weather.responseContext(r.forecast_only_response_context.arguments.weather_read_ids[0]).recallAllowed;
  const explicitMet = f.weather.responseContext(metOnly.weather_read_id).recallAllowed;
  assert.equal(withRain(), true);
  f.consent();
  assert.equal(withRain(), false);
  assert.equal(onlyForecast(), true);
  assert.equal(explicitMet(), true);
  assert.throws(() => f.weather.responseContext(r.weather_read_id).guard());
  assert.equal(f.weather.responseContext(r.forecast_only_response_context.arguments.weather_read_ids[0]).guard(), true);
  f.consent(false);
  assert.equal(onlyForecast(), false);
  assert.equal(explicitMet(), false);
});
