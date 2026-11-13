import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
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
async function fixture(t:TestContext,enabled=false) {
  const dir=mkdtempSync(join(tmpdir(),'health-context-')),path=join(dir,'state.enc'),key=randomBytes(32);let now=NOW,authorized=true;
  const profile=normalizeProfile({height:171,weight:72,birthday:'1992-03-04'},now);
  const observations=normalize('recovery',{recharges:[{date:'2026-11-14',heart_rate_avg:61,breathing_rate_avg:14}]},now);
  new HealthVault(path).write(key,{version:1,connection:{clientId:'fixture',clientSecret:'fixture-secret',accessToken:'fixture-token',userId:123,expiresAt:NOW+86400_000},owner:'owner',enabled,deletedBefore:0,profileDeleted:false,profile,observations});
  let collect=async()=>({observations,profile});let sent=0,profileCalls=0;
  const api=new PolarAPI();api.collect=async()=>collect();api.profile=async()=>{profileCalls++;return profile;};api.disconnect=async()=>{};
  const h=new HealthContext(path,{key:async()=>Buffer.from(key),now:()=>now,ownerAuthorized:o=>authorized&&o==='owner',ownerRevoked:()=>!authorized,
    announce:async(_,guard)=>{await settle();if(!guard())throw new Error('revoked');sent++;return {stored:true};},api,hosts:['example.com'],sender:new WebhookSender(async()=>({status:204,body:''}))});
  t.after(()=>{h.close();rmSync(dir,{recursive:true,force:true});});await h.setup({action:'status'});
  return {h,path,key,profile,observations,sent:()=>sent,profileCalls:()=>profileCalls,advance:(ms:number)=>{now+=ms;},revoke:()=>{authorized=false;},collect:(f:typeof collect)=>{collect=f;},control:(action:string)=>h.control({protocol:1,epoch:h.status('owner').healthEpoch,action},'owner')};
}
test('OFF is authoritative, consent cannot cross owners, reads expire and revocation blocks responses',async t=>{
  const f=await fixture(t);assert.equal(f.h.read({}).status,'unavailable');
  await assert.rejects(f.h.control({protocol:1,epoch:f.h.status('owner').healthEpoch,action:'enable'},'other'));
  await f.control('enable');await settle();const r=f.h.read({categories:['recovery']});assert.equal(r.status,'available');assert.ok('read_id' in r);
  await f.control('disable');await assert.rejects(f.h.respond({read_id:r.read_id,disposition:'announce',text:'test'}));
  await f.control('enable');await settle();const r2=f.h.read({});assert.ok('read_id' in r2);f.revoke();assert.equal(f.h.read({}).status,'unavailable');await assert.rejects(f.h.respond({read_id:r2.read_id,disposition:'announce',text:'test'}));assert.equal(f.sent(),0);
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
