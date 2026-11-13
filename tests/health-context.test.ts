import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, renameSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {HealthContext} from '../server/health/context.ts';
import {HealthVault} from '../server/health/vault.ts';
import {PolarAPI} from '../server/health/polar.ts';
import {normalize, normalizeProfile, RETENTION} from '../server/health/data.ts';
import {WebhookSender} from '../server/webhook.ts';
import {HealthSharing} from '../src/health-sharing.ts';
const NOW=Date.parse('2026-11-14T12:00:00Z');
const settle=()=>new Promise(r=>setImmediate(r));
async function fixture(t:TestContext,enabled=false,activity=false,heartRate=false) {
  const dir=mkdtempSync(join(tmpdir(),'health-context-')),path=join(dir,'state.enc'),key=randomBytes(32);let now=NOW,authorized=true;
  const profile=normalizeProfile({height:171,weight:72,birthday:'1992-03-04'},now);
  const observations=normalize('recovery',{recharges:[{date:'2026-11-14',heart_rate_avg:61,breathing_rate_avg:14}]},now);
  if(activity)observations.push(...normalize('activity',[{start_time:'2026-11-14T00:00:00+00:00',daily_activity:123.45,active_duration:'PT2H5M',steps:1000}],now));
  if(heartRate)observations.push(...normalize('heart_rate',[{date:'2026-11-14',heart_rate_samples:Array.from({length:3000},(_,i)=>({sample_time:new Date(i*28*1000).toISOString().slice(11,19),heart_rate:i===2999?150:65}))}],now));
  new HealthVault(path).write(key,{version:1,connection:{clientId:'fixture',clientSecret:'fixture-secret',accessToken:'fixture-token',userId:123,expiresAt:NOW+86400_000},owner:'owner',enabled,deletedBefore:0,profileDeleted:false,profile,observations});
  let collect=async()=>({observations,profile});let sent=0,profileCalls=0;const texts:string[]=[];
  const api=new PolarAPI();api.collect=async()=>collect();api.profile=async()=>{profileCalls++;return profile;};api.disconnect=async()=>{};
  const h=new HealthContext(path,{key:async()=>Buffer.from(key),now:()=>now,ownerAuthorized:o=>authorized&&o==='owner',ownerRevoked:()=>!authorized,
    announce:async(message,guard)=>{await settle();if(!guard())throw new Error('revoked');sent++;texts.push(message.text);return {stored:true};},api,hosts:['example.com'],sender:new WebhookSender(async()=>({status:204,body:''}))});
  t.after(()=>{h.close();rmSync(dir,{recursive:true,force:true});});await h.setup({action:'status'});
  return {h,path,key,profile,observations,texts,sent:()=>sent,profileCalls:()=>profileCalls,advance:(ms:number)=>{now+=ms;},revoke:()=>{authorized=false;},collect:(f:typeof collect)=>{collect=f;},control:(action:string)=>h.control({protocol:1,epoch:h.status('owner').healthEpoch,action},'owner')};
}
test('OFF is authoritative, consent cannot cross owners, reads expire and revocation blocks responses',async t=>{
  const f=await fixture(t);assert.equal(f.h.read({}).status,'unavailable');
  await assert.rejects(f.h.control({protocol:1,epoch:f.h.status('owner').healthEpoch,action:'enable'},'other'));
  await f.control('enable');await settle();const r=f.h.read({categories:['recovery']});assert.equal(r.status,'available');assert.ok('read_id' in r);
  await f.control('disable');await assert.rejects(f.h.respond({read_id:r.read_id,disposition:'announce',text:'test'}));
  await f.control('enable');await settle();const r2=f.h.read({});assert.ok('read_id' in r2);f.revoke();assert.equal(f.h.read({}).status,'unavailable');await assert.rejects(f.h.respond({read_id:r2.read_id,disposition:'announce',text:'test'}));assert.equal(f.sent(),0);
});

test('heart-rate context exposes full-response summaries with bounded detail, legacy scope and existing access guards',async t=>{
 const f=await fixture(t,true,false,true);
 const r=f.h.read({categories:['heart_rate'],hours:168});assert.ok('observations' in r);
 const row=r.observations[0];assert.ok('heart_rate_summary' in row);
 assert.equal(row.heart_rate_summary!.sample_count,3000);assert.equal(row.heart_rate_summary!.max_bpm,150);
 assert.equal(row.samples!.length,96);assert.equal(row.samples!.at(-1)!.value,150);
 assert.equal(row.samples_total,3000);assert.equal(row.samples_reduced,true);assert.deepEqual(row.values,{});
 assert.equal(r.heart_rate_metrics!.utc_offset_minutes,null);assert.equal(r.heart_rate_metrics!.time_basis,'source_device_clock');
 const activity=f.h.read({categories:['activity']});assert.ok('observations' in activity);assert.equal(activity.heart_rate_metrics,undefined);
 // At this time, the date's UTC+14 retention anchor is already 26 hours old.
 // A last-24h read must still include the potentially overlapping device day.
 const recent=f.h.read({categories:['heart_rate'],hours:24});assert.ok('observations' in recent);
 assert.equal(recent.observations.length,1);assert.equal(recent.heart_rate_metrics!.requested_hours,24);
 await f.control('disable');assert.equal(f.h.read({categories:['heart_rate']}).status,'unavailable');
 await assert.rejects(f.h.respond({read_id:r.read_id,disposition:'announce',text:'old data'}));
 const legacy=f.observations.find(x=>x.category==='heart_rate')!;legacy.values={};legacy.samples=[{time:'00:01:00',value:65},{time:'03:00:00',value:85}];
 await f.control('enable');await settle();
 const old=f.h.read({categories:['heart_rate'],hours:168});assert.ok('observations' in old);
 const oldRow=old.observations[0];assert.ok('heart_rate_summary' in oldRow);
 assert.equal(oldRow.heart_rate_summary!.basis,'legacy_stored_samples');assert.equal(oldRow.heart_rate_summary!.sample_count,2);
 await f.control('delete');assert.equal(f.h.read({categories:['heart_rate']}).status,'unavailable');
 assert.deepEqual((new HealthVault(f.path).read(f.key) as any).observations,[]);
});
test('delete cancels an in-flight fetch; re-enable cannot restore earlier measurements or profile',async t=>{
  const f=await fixture(t);let finish!:(v:{observations:typeof f.observations;profile:typeof f.profile})=>void;
  f.collect(()=>new Promise(r=>{finish=r;}));await f.control('enable');await settle();await f.control('delete');finish({observations:f.observations,profile:f.profile});await settle();
  let disk=new HealthVault(f.path).read(f.key) as any;assert.deepEqual(disk.observations,[]);assert.equal(disk.profile,undefined);assert.equal(disk.enabled,false);
  f.collect(async()=>({observations:f.observations,profile:f.profile}));await f.control('enable');await settle();
  disk=new HealthVault(f.path).read(f.key) as any;assert.deepEqual(disk.observations,[]);assert.equal(disk.profile,undefined);
  await f.control('refresh');await settle();assert.equal(f.profileCalls(),1);assert.equal((f.h.read({profile:true}) as any).profile.weight_kg,72);
});
test('expiry is measurement based, silence and concurrent retries are idempotent',async t=>{
  const f=await fixture(t,true);const r=f.h.read({categories:['recovery']});assert.ok('read_id' in r);
  const p={read_id:r.read_id,disposition:'announce',text:'A useful answer'};
  await Promise.all([f.h.respond(p),f.h.respond(p)]);assert.equal(f.sent(),1);
  await assert.rejects(f.h.respond({...p,text:'Different answer'}));
  const silent=f.h.read({});assert.ok('read_id' in silent);await f.h.respond({read_id:silent.read_id,disposition:'silent'});await assert.rejects(f.h.respond({...p,read_id:silent.read_id}));
  f.advance(RETENTION);assert.equal(f.h.read({}).status,'unavailable');assert.deepEqual((new HealthVault(f.path).read(f.key) as any).observations,[]);
  assert.equal(readFileSync(f.path).includes(Buffer.from('1992-03-04')),false);
});
test('Even does not claim an offline change succeeded or accept replies from a previous target',async()=>{
  let target='a',now=0,finish!:(v:unknown)=>void;
  const ui=new HealthSharing({target:()=>target,now:()=>now,changed:()=>{},api:()=>new Promise(r=>{finish=r;})});
  ui.receive({healthProtocol:1,healthEpoch:'epoch',healthEnabled:true,healthConfigured:true});
  const p=ui.control('disable');target='b';ui.reset();finish({healthProtocol:1,healthEpoch:'epoch',healthEnabled:false});await p;assert.equal(ui.status().supported,false);
  target='a';ui.receive({healthProtocol:1,healthEpoch:'epoch',healthEnabled:true});now=50_000;await ui.control('delete');assert.equal(ui.status().failed,true);assert.equal(ui.status().healthEnabled,undefined);
});

test('unavailable Keychain fails closed without replacing ciphertext; explicit access retry restores it',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'health-locked-')),path=join(dir,'health.enc'),key=randomBytes(32);let locked=true;
 new HealthVault(path).write(key,{version:1,enabled:false,deletedBefore:0,profileDeleted:false,observations:[],profile:normalizeProfile({weight:70,birthday:'1990-02-03'},NOW)});
 const before=readFileSync(path);
 const h=new HealthContext(path,{key:async operation=>{if(operation==='authorize'){locked=false;return;}if(locked)throw new Error('key locked');return Buffer.from(key);},now:()=>NOW,ownerAuthorized:()=>true,ownerRevoked:()=>false,announce:async()=>({}),sender:new WebhookSender(async()=>({status:204,body:''})),hosts:[]});
 t.after(()=>{h.close();rmSync(dir,{recursive:true,force:true});});
 assert.equal((await h.setup({action:'status'})).status,'locked');assert.equal(h.read({profile:true}).status,'unavailable');assert.deepEqual(readFileSync(path),before);
 assert.equal((await h.setup({action:'unlock'})).status,'ready');assert.equal(h.status('owner').healthHasProfile,true);assert.equal(h.read({}).status,'unavailable');
});
test('guard is checked again while a health-derived message waits for delivery',async t=>{
 const f=await fixture(t,true),r=f.h.read({});assert.ok('read_id' in r);
 const response=f.h.respond({read_id:r.read_id,disposition:'announce',text:'A useful answer'});
 const rejection=assert.rejects(response);await f.control('disable');await rejection;assert.equal(f.sent(),0);
});


test('health response preserves conversational attribution without an automatic footer; unused reads can stay silent',async t=>{
 const f=await fixture(t,true),r=f.h.read({categories:['recovery']});assert.ok('read_id' in r);
 const text='Polarのデータでは回復が遅めのようだし、今日は予定に余裕を持たせようか。';
 const response={read_id:r.read_id,disposition:'announce',text};
 await f.h.respond(response);await f.h.respond(response);
 assert.deepEqual(f.texts,[text]);
 const unused=f.h.read({});assert.ok('read_id' in unused);
 await f.h.respond({read_id:unused.read_id,disposition:'silent'});
 assert.deepEqual(f.texts,[text]);
});

test('storage faults remain distinct and recovery leaves sharing off',async t=>{
 const f=await fixture(t,true);
 renameSync(f.path,f.path+'.previous');mkdirSync(f.path);
 await assert.rejects(f.control('disable'),/HEALTH_STORAGE_UNAVAILABLE/);
 assert.equal(f.h.setupStatus().status,'HEALTH_STORAGE_UNAVAILABLE');
 assert.equal(f.h.status('owner').healthStatus,'HEALTH_STORAGE_UNAVAILABLE');
 assert.equal(f.h.read({}).status,'unavailable');
 await assert.rejects(f.h.setup({action:'retry_storage'}),/HEALTH_STORAGE_UNAVAILABLE/);
 rmSync(f.path,{recursive:true});renameSync(f.path+'.previous',f.path);
 assert.equal((await f.h.setup({action:'retry_storage'})).status,'ready');
 assert.equal(f.h.setupStatus().sharing,false);
});
test('routine collection without a profile preserves the latest saved profile',async t=>{
 const f=await fixture(t);f.collect(async()=>({observations:f.observations,profile:undefined as any}));
 await f.control('enable');await settle();
 assert.deepEqual((f.h.read({profile:true}) as any).profile,f.profile);
});

 test('activity context explains goal percentage for existing encrypted provider fields without clamping',async t=>{
 const f=await fixture(t,true,true);
 const r=f.h.read({categories:['activity']});assert.ok('observations' in r);
 assert.equal(r.observations.length,1);
 assert.equal(r.observations[0].values.activity_goal_completion_percent,123.45);
 assert.equal('daily_activity' in r.observations[0].values,false);
 assert.equal(r.observations[0].values.active_duration,'PT2H5M');
 assert.equal(r.activity_metrics?.activity_goal_completion_percent.unit,'%');
 assert.match(r.activity_metrics!.activity_goal_completion_percent.meaning,/daily activity goal/);
 assert.equal((new HealthVault(f.path).read(f.key) as any).observations.find((x:any)=>x.category==='activity').values.daily_activity,123.45);
 const recovery=f.h.read({categories:['recovery']});assert.ok('observations' in recovery);
 assert.equal(recovery.activity_metrics,undefined);
});
