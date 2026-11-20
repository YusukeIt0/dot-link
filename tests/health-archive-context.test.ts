import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync,existsSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HealthContext} from '../server/health/context.ts';
import {HealthVault} from '../server/health/vault.ts';
import {PolarAPI} from '../server/health/polar.ts';
import {normalize,normalizeProfile,type Observation} from '../server/health/data.ts';
import type {HistoryPeriod} from '../server/history/retention.ts';
import {WebhookSender} from '../server/webhook.ts';

const DAY=86_400_000, initial=Date.UTC(2026,9,15,12);
const iso=(ms:number)=>new Date(ms).toISOString();
const owner='synthetic-owner';
const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
function exercise(id:string,at:number,received:number,sport='WALKING') {
  return normalize('exercise',[{id,start_time:iso(at),sport}],received)[0]!;
}
async function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'polar-archive-context-')), path=join(dir,'health.enc');
  const vault=new HealthVault(path), key=randomBytes(32);
  const old=exercise('existing',initial-DAY,initial-DAY/2);
  const state={version:1,connection:{clientId:'app',clientSecret:'fixture',accessToken:'synthetic',userId:1,expiresAt:initial+400*DAY},
    owner,enabled:true,deletedBefore:0,profileDeleted:false,profile:normalizeProfile({weight:70},initial),observations:[old]};
  vault.write(key,state);
  let now=initial, period:HistoryPeriod|undefined='1y', revoked=false, allowClock=true;
  let load=async()=>[] as Observation[];
  const api=new PolarAPI({fetch:async()=>{throw Error('Unexpected external request');},now:()=>now});
  api.collect=async()=>({observations:await load()});
  api.disconnect=async()=>{};
  let beforeDelivery=async()=>{};
  let deliveries=0;
  const receivedDates:string[][]=[];
  const make=()=>new HealthContext(path,{key:async()=>Buffer.from(key),now:()=>now,
    ownerAuthorized:id=>id===owner&&!revoked,ownerRevoked:id=>id===owner&&revoked,
    archivePeriod:id=>id===owner?period:undefined,
    phoneTime:(dates,id)=>{assert.equal(id,owner);receivedDates.push(dates);return {evidence:{status:'unavailable'},allowed:()=>allowClock};},
    api,announce:async(_input,guard)=>{await beforeDelivery();guard();deliveries++;return {stored:true};},
    hosts:[],sender:new WebhookSender(async()=>{throw Error('unexpected notification');})});
  let h=make();
  t.after(()=>{h.close();rmSync(dir,{recursive:true,force:true});});
  await h.setup({action:'status'});
  async function setting(action:'enable'|'disable'|'delete') {
    return h.control({protocol:1,epoch:h.status(owner).healthEpoch,action},owner);
  }
  async function poll(loader:typeof load) {
    load=loader; await setting('enable');
    for(let i=0;i<50;i++){await pause();if(!h.status(owner).healthPending)return;}
    throw Error('Synthetic acquisition did not finish');
  }
  const change=async(choice:{action:'set';enabled:boolean}|{action:'delete'})=>h.archiveControl(owner,(await h.archiveStatus(owner)).epoch!,choice);
  const read=(fields:string[]=['sport'],limit=50)=>{
    const result=h.readSelectedHistory({fields,start_at:iso(initial-3*DAY),end_at:iso(now+1),limit});
    assert.ok('read_id' in result);return result;
  };
  return {get h(){return h;},path,dir,old,read,poll,change,setting,key,vault,receivedDates,now:()=>now,advance:(ms:number)=>{now+=ms;},
    period:(p:HistoryPeriod|undefined)=>{period=p;},clock:(yes:boolean)=>{allowClock=yes;},revoke:()=>{revoked=true;},
    collecting:(fn:typeof load)=>{load=fn;},delivering:(fn:typeof beforeDelivery)=>{beforeDelivery=fn;},deliveries:()=>deliveries,
    peer:async()=>{const peer=make();t.after(()=>peer.close());await peer.setup({action:'status'});return peer;},
    restart:async()=>{h.close();h=make();await h.setup({action:'status'});}};
}

test('first authorized late observations keep their assigned period; preceding seven-day records do not migrate',async t=>{
  const f=await fixture(t);
  assert.equal((await f.h.archiveStatus(owner)).enabled,false);
  assert.equal((await f.h.archiveStatus('other')).epoch,null);
  assert.ok(!existsSync(f.path+'.history'));
  const initialStatus=await f.change({action:'set',enabled:true});
  assert.equal(initialStatus.enabled,true);
  await assert.rejects(f.h.archiveControl('other',initialStatus.epoch!,{action:'delete'}));
  f.advance(1);
  const late=exercise('first-late',initial-2*DAY,f.now());
  const heart=normalize('heart_rate',[{date:iso(initial-DAY).slice(0,10),heart_rate_samples:[{sample_time:'06:00:00',heart_rate:68}]}],f.now())[0]!;
  const corrected={...f.old,retrieved_at:iso(f.now()),values:{...f.old.values,sport:'CYCLING'}};
  await f.poll(async()=>[late,corrected,heart]);
  const all=f.read(); assert.equal(all.entries.length,2);
  assert.equal(new Set(all.entries.map(r=>r.id)).size,2);
  assert.ok(all.next_cursor); assert.equal(f.h.readSelectedHistory({cursor:all.next_cursor}).entries.length,0);
  await f.restart();
  assert.equal((await f.h.archiveStatus(owner)).enabled,true);
  f.advance(8*DAY); f.period('1m');
  const long=f.read(); assert.equal(long.entries.length,1);
  assert.equal(long.entries[0].id,late.id); assert.equal((long.entries[0] as any).retention.period,'1y');
  assert.equal(long.entries[0].retrieved_at,late.retrieved_at);
  const joined=f.read(['heart_rate_summary']);
  assert.equal(joined.entries.length,1); assert.ok('phone_time_evidence' in joined);
  assert.ok(f.receivedDates.length); f.clock(false);
  assert.throws(f.h.responseGuard(joined.read_id!),/phone-clock/);
  assert.equal(f.h.responseGuard(long.read_id!)(),true);
  await f.change({action:'set',enabled:false});
  assert.throws(f.h.responseGuard(long.read_id!));
  assert.equal(f.read().entries.length,0);
  assert.equal(f.h.status(owner).healthEnabled,true);
  await f.change({action:'set',enabled:true});assert.equal(f.read().entries.length,1);
  await f.setting('disable');assert.equal((await f.h.archiveStatus(owner)).enabled,false);
  await f.setting('enable');await pause();assert.equal((await f.h.archiveStatus(owner)).enabled,false);
});

test('archive delete preserves profile and live sharing, invalidates in-flight work and prevents reimport from the old measured interval',async t=>{
  const f=await fixture(t); await f.change({action:'set',enabled:true});
  const oldPath=join(f.path+'.history',readdirSync(f.path+'.history').find(n=>n.endsWith('.sqlite'))!);
  let complete!:(rows:Observation[])=>void;
  f.collecting(()=>new Promise<Observation[]>(r=>{complete=r;}));
  await f.setting('enable');await pause();
  const r=f.read();const status=await f.change({action:'delete'});
  assert.equal(status.enabled,false);assert.equal(status.available,true);
  complete([f.old]);await pause();
  assert.ok(!existsSync(oldPath));
  assert.equal(f.h.status(owner).healthHasProfile,true);
  assert.equal(f.h.status(owner).healthEnabled,true);
  assert.throws(f.h.responseGuard(r.read_id!));
  assert.equal(f.read().entries.length,0);
  await f.change({action:'set',enabled:true});f.advance(1000);
  const fresh=exercise('fresh',f.now()-1,f.now());
  await f.poll(async()=>[{...f.old,retrieved_at:iso(f.now())},fresh]);
  assert.deepEqual(f.read().entries.map(e=>e.id),[fresh.id]);
  await f.setting('delete');
  assert.equal(f.h.status(owner).healthHasProfile,false);assert.equal(f.h.status(owner).healthEnabled,false);
  assert.ok(!readdirSync(f.path+'.history').some(n=>n.endsWith('.sqlite')));
});

test('legacy-client writes retire prior authority even for the same Polar account, and ciphertext from a retired generation fails closed',async t=>{
  const f=await fixture(t);await f.change({action:'set',enabled:true});
  f.advance(1);const late=exercise('new',initial-DAY,f.now());
  await f.poll(async()=>[late]);
  const dataPath=()=>join(f.path+'.history',readdirSync(f.path+'.history').find(n=>n.endsWith('.sqlite'))!);
  const previous=dataPath(),backup=join(f.dir,'old-ciphertext');
  copyFileSync(previous,backup);f.h.close();
  const legacy=f.vault.read(f.key) as Record<string,unknown>;
  assert.ok(!('archive' in legacy));
  f.vault.write(f.key,legacy); // The older application can still open and save its unmodified format.
  await f.restart();
  assert.equal((await f.h.archiveStatus(owner)).enabled,false);
  assert.ok(!existsSync(previous));
  await f.change({action:'set',enabled:true});
  assert.notEqual(dataPath(),previous);
  f.advance(8*DAY);copyFileSync(backup,dataPath());
  const read=f.read();
  assert.equal(read.status,'partial');assert.deepEqual(read.entries,[]);
  f.revoke();assert.equal(f.h.historyOwner(),undefined);
  assert.ok(!readdirSync(f.path+'.history').some(n=>n.endsWith('.sqlite')));
});

test('a grant enabled during a provider fetch does not retain its in-flight data beyond the original seven days',async t=>{
  const f=await fixture(t);let finish!:(rows:Observation[])=>void;
  f.collecting(()=>new Promise(r=>{finish=r;}));
  await f.setting('enable');await pause();
  await f.change({action:'set',enabled:true});f.advance(1);
  const row=exercise('in-flight',initial-2*DAY,f.now());
  finish([row]);await pause();
  assert.ok(f.read().entries.some(r=>r.id===row.id));
  f.advance(8*DAY);assert.equal(f.read().entries.length,0);
});

test('period changes fence pending ingestion and delivery; disconnect retires both layers before returning',async t=>{
  const f=await fixture(t);await f.change({action:'set',enabled:true});
  f.advance(1);
  const long=exercise('retained',initial-DAY,f.now());
  await f.poll(async()=>[long]);
  f.advance(1000);
  let finish!:(rows:Observation[])=>void;
  f.collecting(()=>new Promise(r=>{finish=r;}));
  await f.setting('enable'); await pause();
  f.period('1m');
  finish([exercise('cross-period',initial-DAY,f.now())]);await pause();
  f.advance(8*DAY);
  const read=f.read();
  assert.deepEqual(read.entries.map(e=>e.id),[long.id]);
  await f.h.respond({read_id:read.read_id,disposition:'announce',text:'Based on Polar, this walk was recorded.'});
  assert.equal(f.deliveries(),1);
  let resume!:()=>void;
  f.delivering(()=>new Promise(r=>{resume=r;}));
  const pending=f.h.respond({read_id:f.read().read_id,disposition:'announce',text:'Polar recorded a walk.'});
  const stopped=assert.rejects(pending);
  await pause(); await f.h.setup({action:'disconnect'}); resume();await stopped;
  assert.equal(f.deliveries(),1);
  assert.equal(f.h.historyOwner(),undefined);
  assert.ok(!readdirSync(f.path+'.history').some(n=>n.endsWith('.sqlite')));
});

test('independent service instances recheck both grants for enrollment, stop, delete, and final delivery',async t=>{
  const f=await fixture(t);
  const before=await f.h.archiveStatus(owner);
  await assert.rejects(f.h.archiveControl(owner,before.epoch!,{action:'set',enabled:true},()=>false));
  assert.equal((await f.h.archiveStatus(owner)).enabled,false);
  await f.change({action:'set',enabled:true});
  const peer=await f.peer();
  const old=f.read();
  let ready=await peer.archiveStatus(owner);
  await peer.archiveControl(owner,ready.epoch!,{action:'set',enabled:false});
  assert.throws(f.h.responseGuard(old.read_id));
  assert.equal((await f.h.archiveStatus(owner)).enabled,false);
  assert.equal(f.h.historyOwner(),owner);
  assert.equal(f.read().entries.length,1);
  ready=await peer.archiveStatus(owner);
  await peer.archiveControl(owner,ready.epoch!,{action:'delete'});
  assert.equal(f.h.readSelectedHistory({start_at:iso(initial-3*DAY),end_at:iso(initial+1),fields:['sport'],limit:1}).status,'unavailable');
  assert.equal(f.h.historyOwner(),undefined);
  assert.equal(peer.status(owner).healthHasProfile,true);
});
