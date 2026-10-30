import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MobilityAcquisition,type MobilityProviders} from '../server/mobility/context.ts';
import {LocationContext} from '../server/location.ts';
import {WebhookSender} from '../server/webhook.ts';
import {MobilityNetwork} from '../server/mobility/network.ts';
import {Bridge} from '../server/bridge.ts';
import {rpc} from '../server/http.ts';
const origin={latitude:52,longitude:13};
const destination={latitude:52.001,longitude:13,source:'user_provided' as const,reference:'Public test fixture'};
const flush=()=>new Promise<void>(r=>setImmediate(r));
function fixture(t:{after:(fn:()=>void)=>void}){
  const dir=mkdtempSync(join(tmpdir(),'dot-mobility-'));let now=Date.now(),calls=0,clears=0,allowed=true;
  let wait:Promise<void>|undefined,release=()=>{},signal:AbortSignal|undefined,sequence=0;
  const sources:MobilityProviders={walking:{plan:async(_a,_b,s)=>{calls++;signal=s;await wait;return {
    status:'available',endpoints:[],candidates:[{distance_m:112,estimated_seconds:100,path:[origin,destination],contains_ferry:false,steps:[]}],
    source:'Public fixture',retrieved_at:new Date(now).toISOString(),attribution_url:'https://example.test',fix_map_url:'https://example.test',limitations:['Unknown access'],
  };}},terrain:{clear:()=>{clears++;},elevations:async points=>points.map(()=>10),profile:async()=>({status:'available'} as any)}};
  const acquisition=new MobilityAcquisition(()=>sources,()=>now);
  const sender=new WebhookSender(async()=>({status:202,body:'{}'}));
  const context=new LocationContext(join(dir,'location.json'),sender,[],async()=>({}),()=>now,()=>allowed,undefined,()=>acquisition);
  const bridge=new Bridge(join(dir,'bridge.json'),sender,[]);let sharing=randomUUID();
  t.after(()=>{context.close();bridge.close();rmSync(dir,{recursive:true,force:true});});
  const enable=(mobility?:boolean)=>context.control({sharing_id:sharing,enabled:true,...(mobility===undefined?{}:{mobility_enabled:mobility})},'owner');
  const update=(latitude=origin.latitude)=>context.update({sharing_id:sharing,sequence:++sequence,fix:{...origin,latitude,accuracy:5,measured_at:new Date(now).toISOString()}},'owner');
  const input=()=>({context_id:context.read().context!.context_id,destination});
  return {context,bridge,acquisition,sources,enable,update,input,calls:()=>calls,clears:()=>clears,signal:()=>signal,
    advance:(ms:number)=>{now+=ms;},disable:()=>context.control({sharing_id:sharing,enabled:false},'owner'),revoke:()=>{allowed=false;context.status();},
    hold:()=>{wait=new Promise<void>(r=>{release=r;});},release:()=>release(),
    rotate:()=>{sharing=randomUUID();sequence=0;},sharing:()=>sharing,disk:()=>readFileSync(join(dir,'location.json'),'utf8')};
}
test('legacy location consent never enables external walking; validated provenance is required',async t=>{
  const f=fixture(t);f.enable();f.update();const p=f.input();
  await assert.rejects(f.context.readMobility(p),{reason:'mobility_disabled'});assert.equal(f.calls(),0);
  assert.throws(()=>f.enable(true),/new sharing session/);
  f.disable();f.rotate();f.enable(true);f.update();
  await assert.rejects(f.context.readMobility({...f.input(),destination:{...destination,source:'guessed'}}),{reason:'invalid_arguments'});
  await assert.rejects(f.context.readMobility({context_id:f.input().context_id}),{reason:'invalid_arguments'});
  assert.equal(f.calls(),0);
  assert.doesNotMatch(f.disk(),/latitude|longitude|destination|reference/);
});
test('identical calls deduplicate, short cache reuses evidence, and unrelated requests do not queue',async t=>{
  const f=fixture(t);f.enable(true);f.update();f.hold();const p=f.input();
  const a=f.context.readMobility(p),b=f.context.readMobility(p);assert.equal(f.calls(),1);
  const busy=await f.context.readMobility({...p,terrain:true}) as any;assert.equal(busy.status,'busy');
  f.release();assert.deepEqual(await a,await b);await f.context.readMobility(p);assert.equal(f.calls(),1);
  f.advance(30_001);f.update();await f.context.readMobility(f.input());assert.equal(f.calls(),2);
});
for(const action of ['stop','revoke','move','expiry','close'] as const)test(`${action} aborts acquisition before publishing evidence`,async t=>{
  const f=fixture(t);f.enable(true);f.update();f.hold();const result=f.context.readMobility(f.input());
  const rejected=assert.rejects(result);
  if(action==='stop')f.disable();
  if(action==='revoke')f.revoke();
  if(action==='move')f.update(52.01);
  if(action==='expiry'){f.advance(90_001);f.context.status();}
  if(action==='close')f.context.close();
  assert.equal(f.signal()?.aborted,true);await rejected;assert.equal(f.clears(),1);
  f.release();await flush();assert.equal(f.calls(),1);
});
test('busy newer context cannot hide movement away from the active request anchor',async t=>{
  const f=fixture(t);f.enable(true);f.update();f.hold();const result=f.context.readMobility(f.input()),rejected=assert.rejects(result);
  f.update(52.0008);assert.equal((await f.context.readMobility(f.input()) as any).status,'busy');
  f.update(52.0016);assert.equal(f.signal()?.aborted,true);await rejected;f.release();
});
test('terrain-only asks for endpoint models without inventing a route or contacting walking',async t=>{
  const f=fixture(t);f.enable(true);f.update();const result=await f.context.readMobility({context_id:f.input().context_id,walking:false,terrain:true}) as any;
  assert.equal(f.calls(),0);assert.equal(result.walking.status,'not_requested');
  assert.deepEqual(result.terrain.elevations_m,[10]);assert.equal(result.terrain.ascent_m,null);
});
test('ordinary tools respond while mobility is pending and tool errors remain fixed',async t=>{
  const f=fixture(t);f.enable(true);f.update();f.hold();
  const call=(name:string,args:unknown={})=>rpc(f.bridge,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},undefined,f.context) as Promise<any>;
  const pending=call('get_mobility_context',f.input());
  const status=await call('get_status');assert.ok(status.result.structuredContent);
  const invalid=await call('get_mobility_context',{destination:'PRIVATE QUERY'});assert.equal(invalid.error.data.reason,'invalid_arguments');assert.doesNotMatch(JSON.stringify(invalid),/PRIVATE QUERY/);
  f.release();assert.ok((await pending).result.structuredContent.walking);
});
test('authorization callback runs before every actual network request',async()=>{
  let allowed=true,calls=0;
  const network=new MobilityNetwork(async()=>{calls++;return new Response('ok');},()=>{if(!allowed)throw new Error('Revoked');});
  const url=new URL('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1/1.png');
  await network.bytes(url,new AbortController().signal,10);allowed=false;
  await assert.rejects(network.bytes(url,new AbortController().signal,10),/Revoked/);assert.equal(calls,1);
});

test('terrain exposes bounded modeled steep sections, never sections from suspect/missing profiles',async()=>{
  const {TerrainProvider}=await import('../server/mobility/terrain.ts');
  const terrain=new TerrainProvider(new MobilityNetwork(async()=>{throw new Error('No network fixture');}));
  terrain.elevations=async points=>points.map((_,i)=>i*5);
  const profile=await terrain.profile([origin,destination],new AbortController().signal);
  assert.equal(profile.elevation_difference_m,15);assert.equal(profile.steep_sections.length,3);
  assert.ok(profile.steep_sections.every(s=>s.sampled_grade_percent>8&&s.sampled_grade_percent<40));
  terrain.elevations=async points=>points.map((_,i)=>i===1?null:i*5);
  const missing=await terrain.profile([origin,destination],new AbortController().signal);
  assert.equal(missing.ascent_m,null);assert.deepEqual(missing.steep_sections,[]);assert.equal(missing.omitted_steep_sections,null);
});

test('the overall deadline cancels a source even if its promise never settles',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);f.enable(true);f.update();f.hold();
  const pending=f.context.readMobility(f.input()),rejected=assert.rejects(pending,{reason:'acquisition_cancelled'});
  t.mock.timers.tick(40_000);await rejected;
  assert.equal(f.signal()?.aborted,true);assert.equal(f.clears(),1);f.release();
});

test('an older read expires during a request even while the latest fix remains fresh',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);f.enable(true);f.update();const old=f.input();
  f.advance(80_000);f.update();f.hold();
  const pending=f.context.readMobility(old),rejected=assert.rejects(pending);
  f.advance(10_001);t.mock.timers.tick(10_000);await rejected;
  assert.equal(f.signal()?.aborted,true);f.release();
});

test('tool geometry preserves polyline coordinates and bounds oversized route detail',async()=>{
  let large=false;
  const path=[{latitude:38.5,longitude:-120.2},{latitude:40.7,longitude:-120.95},{latitude:43.252,longitude:-126.453}];
  const factory=()=>({walking:{plan:async()=>({status:'available',endpoints:[],source:'fixture',retrieved_at:'2026-01-01T00:00:00Z',attribution_url:'https://example.test',fix_map_url:'https://example.test',limitations:[],candidates:Array.from({length:large?3:1},()=>({distance_m:100,estimated_seconds:100,contains_ferry:false,path:large?Array.from({length:10000},(_,i)=>({latitude:i%2,longitude:i%2})):path,steps:Array.from({length:large?2000:0},()=>({name:'山'.repeat(200),distance_m:1,estimated_seconds:1,mode:'walking' as const,maneuver:'turn',direction:null,position:origin}))}))})},terrain:{elevations:async()=>[],profile:async()=>({} as any),clear:()=>{}}}) as MobilityProviders;
  const acquisition=new MobilityAcquisition(factory);
  const input={context_id:randomUUID(),destination,walking:true,terrain:false};
  const small=await acquisition.query(input,origin,Date.now()+90_000,()=>{}) as any;
  assert.equal(small.walking.candidates[0].geometry.value,'_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  acquisition.clear();large=true;
  // A separate instance represents a new test owner, not a production throttle reset.
  const big=new MobilityAcquisition(factory);
  try{
    const result=await big.query(input,origin,Date.now()+90_000,()=>{}) as any;
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=128*1024);
    assert.ok(result.walking.candidates.some((c:any)=>c.geometry.omitted));
    assert.ok(result.walking.candidates.every((c:any)=>c.steps.length<=120&&c.omitted_steps===2000-c.steps.length&&c.steps.every((s:any)=>s.name.length===120)));
  }finally{big.clear();}
});


test('unavailable walking preserves partial endpoint evidence without inventing access',async t=>{
  const f=fixture(t);f.enable(true);f.update();
  f.sources.walking.plan=async()=>({status:'unavailable',candidates:[],endpoints:[],source:'fixture',retrieved_at:new Date().toISOString(),attribution_url:'https://example.test',fix_map_url:'https://example.test',limitations:['Source unavailable; path existence unknown']});
  f.sources.terrain.elevations=async()=>[null,10];
  const result=await f.context.readMobility({...f.input(),terrain:true}) as any;
  assert.equal(result.walking.status,'unavailable');assert.deepEqual(result.walking.candidates,[]);
  assert.equal(result.terrain.status,'partial');assert.deepEqual(result.terrain.elevations_m,[null,10]);
  assert.equal(result.terrain.elevation_difference_m,null);assert.equal(result.terrain.ascent_m,null);
  assert.match(result.terrain.limitations.join(' '),/do not establish a connecting path/);
});
