import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {HealthContext} from '../server/health/context.ts';
import {HealthVault} from '../server/health/vault.ts';
import {PolarAPI} from '../server/health/polar.ts';
import {normalize, normalizeProfile} from '../server/health/data.ts';
import {WebhookSender} from '../server/webhook.ts';

const NOW=Date.parse('2026-11-14T12:00:00Z');
const settle=()=>new Promise(r=>setImmediate(r));
/** Health sharing enabled, with Keychain deletion controlled by the test. */
async function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'health-reset-')),path=join(dir,'state.enc'),key=randomBytes(32);
  const profile=normalizeProfile({height:171,weight:72,birthday:'1992-03-04'},NOW);
  const observations=normalize('recovery',{recharges:[{date:'2026-11-14',heart_rate_avg:61,breathing_rate_avg:14}]},NOW);
  new HealthVault(path).write(key,{version:1,connection:{clientId:'fixture',clientSecret:'fixture-secret',accessToken:'fixture-token',userId:123,expiresAt:NOW+86400_000},owner:'owner',enabled:true,deletedBefore:0,profileDeleted:false,profile,observations});
  const issued:Buffer[]=[];let finishDelete:((error?:Error)=>void)|undefined;let collects=0;
  const api=new PolarAPI();api.collect=async()=>{collects++;return {observations,profile};};api.profile=async()=>profile;api.disconnect=async()=>{};
  const h=new HealthContext(path,{key:async operation=>{
    if(operation==='delete')return new Promise((resolve,reject)=>{finishDelete=error=>error?reject(error):resolve(undefined);});
    const copy=Buffer.from(key);issued.push(copy);return copy;
  },now:()=>NOW,ownerAuthorized:o=>o==='owner',ownerRevoked:()=>false,announce:async()=>({stored:true}),api,hosts:['example.com'],
  sender:new WebhookSender(async()=>({status:204,body:''}))});
  t.after(()=>{finishDelete?.();h.close();rmSync(dir,{recursive:true,force:true});});
  await h.setup({action:'status'});
  return {h,path,issued,collects:()=>collects,finishDelete:(error?:Error)=>finishDelete!(error)};
}

test('reset closes reads, responses, events and acquisition before Keychain deletion completes',async t=>{
  const f=await fixture(t);
  const before=f.h.read({categories:['recovery']});assert.equal(before.status,'available');assert.ok('read_id' in before);
  assert.equal(f.h.status('owner').healthEnabled,true);
  const reset=f.h.setup({action:'reset'});
  await settle();
  // Deletion is still pending here.
  assert.equal(f.h.read({}).status,'unavailable');
  assert.equal(f.h.status('owner').healthEnabled,false);
  await assert.rejects(f.h.respond({read_id:before.read_id,disposition:'announce',text:'late'}));
  await assert.rejects(f.h.control({protocol:1,epoch:f.h.status('owner').healthEpoch,action:'refresh'},'owner'));
  assert.equal(f.collects(),0,'no new acquisition starts');
  assert.ok(f.issued.every(key=>key.every(byte=>byte===0)),'the old key is zeroed while deletion is pending');
  f.finishDelete();
  assert.equal((await reset).configured,false);
});

test('a failed Keychain deletion keeps sharing closed, zeroes the key and never recreates the vault',async t=>{
  const f=await fixture(t);
  const reset=f.h.setup({action:'reset'});await settle();
  f.finishDelete(new Error('HEALTH_KEY_UNAVAILABLE'));
  await assert.rejects(reset,/HEALTH_KEY_UNAVAILABLE/);
  assert.ok(f.issued.length>0&&f.issued.every(key=>key.every(byte=>byte===0)));
  assert.equal(f.h.read({}).status,'unavailable');
  assert.equal(f.h.status('owner').healthEnabled,false);
  assert.equal((await f.h.setup({action:'status'})).configured,false);
  await assert.rejects(f.h.control({protocol:1,epoch:f.h.status('owner').healthEpoch,action:'enable'},'owner'));
  await settle();
  assert.equal(existsSync(f.path),false,'the removed vault is not written again');
  assert.equal(f.collects(),0);
});
