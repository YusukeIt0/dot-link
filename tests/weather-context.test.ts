import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {WeatherContext, WEATHER_TERMS} from '../server/weather/context.ts';
import {weatherSource, weatherQueryPoint, type WeatherEvidence, type WeatherPoint} from '../server/weather/types.ts';
import {LocationContext} from '../server/location.ts';
import {WebhookSender} from '../server/webhook.ts';
import {WeatherSharing} from '../src/weather-sharing.ts';
const owner='a'.repeat(64);
const flush=()=>new Promise<void>(r=>setImmediate(r));
function fixture(t:TestContext) {
 const dir=mkdtempSync(join(tmpdir(),'weather-context-'));let now=Date.parse('2026-11-10T09:20:00Z');let authorized=true;
 const events:unknown[]=[];
 const sender=new WebhookSender(async (_url,raw)=>{const e=JSON.parse(raw);if(e.type==='verification')return {status:200,body:JSON.stringify({challenge:e.challenge})};events.push(e);return {status:202,body:'{}'};});
 const location=new LocationContext(join(dir,'location.json'),sender,['callback.example.test'],async (_input,guard)=>{guard();return {stored_for_g2:true};},()=>now,()=>authorized);
 const sharing=randomUUID();let seq=0,calls=0,temp=20,humidity=70;
 let load:undefined|((point:WeatherPoint,signal:AbortSignal)=>Promise<WeatherEvidence>);
 const evidence=(point:WeatherPoint):WeatherEvidence=>({status:'ready',source:weatherSource,data_kind:'model_forecast',query_point:weatherQueryPoint(point),as_of:new Date(now).toISOString(),retrieved_at:new Date(now).toISOString(),checked_at:new Date(now).toISOString(),updated_at:'2026-11-10T09:00:00Z',retry_at:null,elevation_m:0,apparent_temperature_c:null,limitations:[],forecast:[],current:{valid_at:'2026-11-10T09:00:00Z',temperature_c:temp,humidity_percent:humidity,wind_m_s:1,wind_from_degrees:0,pressure_hpa:1000,cloud_percent:20,precipitation:[]}});
 const service={query:async (p:WeatherPoint,s:AbortSignal,g:()=>void)=>{calls++;g();return load?load(p,s):evidence(p);},cancel(){},close(){}};
 const create=()=>new WeatherContext(join(dir,'consent.json'),service,location,{ownerAuthorized:()=>authorized,now:()=>now,automatic:false});
 const weather=create();t.after(()=>{weather.close();location.close();rmSync(dir,{recursive:true,force:true});});
 const consent=(enabled=true)=>weather.control({protocol:1,epoch:weather.status(owner).weatherEpoch,enabled,...(enabled?{terms:WEATHER_TERMS}:{})},owner);
 const update=(latitude=10)=>location.update({sharing_id:sharing,sequence:++seq,fix:{latitude,longitude:20,accuracy:5,measured_at:new Date(now).toISOString()}},owner);
 const enable=()=>location.control({sharing_id:sharing,enabled:true},owner);
 const subscribe=()=>location.subscribe({name:'location.updated',arguments:{session_id:'personal-g2'},delivery:{mode:'webhook',url:'https://callback.example.test/location',secret:'whsec_'+randomBytes(32).toString('base64')}});
 return {weather,location,events,consent,update,enable,subscribe,create,evidence,calls:()=>calls,setLoad:(f:typeof load)=>{load=f;},setValues:(a:number,b:number)=>{temp=a;humidity=b;},advance:(ms:number)=>{now+=ms;},revoke:()=>{authorized=false;},stop:()=>location.control({sharing_id:sharing,enabled:false},owner)};
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
