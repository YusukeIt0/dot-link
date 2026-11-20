import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HealthContext, type HealthOptions} from '../server/health/context.ts';
import {normalize, normalizeProfile, RETENTION, type Observation} from '../server/health/data.ts';
import {HealthVault} from '../server/health/vault.ts';
import {WebhookSender} from '../server/webhook.ts';

const now=Date.parse('2026-11-15T12:00:00Z'), iso=(t:number)=>new Date(t).toISOString();
const hour=3_600_000;
async function fixture(t:TestContext,observations:Observation[],phoneTime?:HealthOptions['phoneTime'],tokenExpiry=now+RETENTION) {
  const dir=mkdtempSync(join(tmpdir(),'polar-history-')), path=join(dir,'health.enc'), key=randomBytes(32);
  let clock=now,allowed=true;
  new HealthVault(path).write(key,{version:1,connection:{clientId:'fixture',clientSecret:'secret',accessToken:'fixture',userId:1,expiresAt:tokenExpiry},
    enabled:true,owner:'owner',deletedBefore:0,profileDeleted:false,profile:normalizeProfile({weight:70},now),observations});
  const context=new HealthContext(path,{key:async()=>Buffer.from(key),now:()=>clock,ownerAuthorized:()=>allowed,ownerRevoked:()=>false,
    hosts:[],phoneTime,announce:async()=>{throw Error('unexpected message');},sender:new WebhookSender(async()=>{throw Error('unexpected webhook');})});
  t.after(()=>{context.close();rmSync(dir,{recursive:true,force:true});});
  await context.setup({action:'status'});
  const read=(fields:string[],start=now-7*24*hour,end=now,limit=50)=>{
    const page=context.readSelectedHistory({fields,start_at:iso(start),end_at:iso(end),limit});
    assert.ok('coverage' in page);
    return page;
  };
  return {context,read,advance:(ms:number)=>clock+=ms,authorize:(value:boolean)=>{allowed=value;}};
}
const act=(start:string,more:Record<string,unknown>)=>normalize('activity',[{start_time:start,...more}],now)[0];
const heart=(day:string)=>normalize('heart_rate',[{date:day,heart_rate_samples:[{sample_time:'10:00:00',heart_rate:61},{sample_time:'14:30:00',heart_rate:88}]}],now)[0];

test('shared historical window selects whole provider days, overlapping sleep and only recorded exercise starts',async t=>{
  const start=Date.parse('2026-11-12T12:00:00Z'),end=start+hour;
  const sleep=normalize('sleep',{nights:[{sleep_start_time:'2026-11-12T07:30:00-04:00',sleep_end_time:'2026-11-12T08:30:00-04:00',sleep_score:83}]},now);
  const exercises=normalize('exercise',[
    {id:'previous',start_time:iso(start-1),duration:'PT1H',sport:'WALKING'},
    {id:'at-start',start_time:iso(start),sport:'RUNNING'},
    {id:'at-end',start_time:iso(end),sport:'CYCLING'}],now);
  const offsetActivity=act('2026-11-12T00:00:00+09:00',{steps:1234,daily_activity:145});
  const f=await fixture(t,[...sleep,...exercises,offsetActivity,heart('2026-11-12')],()=>{throw Error('unrequested phone clock');});
  const page=f.read(['steps','activity_goal_completion_percent','sleep_score','sport'],start,end);
  assert.equal(page.entries.length,3);
  const byCategory=Object.fromEntries(page.entries.map(e=>[e.category,e]));
  assert.deepEqual(byCategory.activity.fields,{steps:1234,activity_goal_completion_percent:145});
  assert.equal(byCategory.activity.measured_at,'2026-11-11T15:00:00.000Z');
  assert.equal(byCategory.activity.temporal_scope,'whole_source_day_possibly_overlapping_window');
  assert.equal(byCategory.sleep.interval_end_at,'2026-11-12T08:30:00-04:00');
  assert.equal(byCategory.exercise.temporal_scope,'recorded_start_in_window');assert.deepEqual(byCategory.exercise.fields,{sport:'RUNNING'});
  assert.ok(!('profile' in page));assert.ok(!('phone_time_evidence' in page));
  assert.throws(()=>f.read(['weight_kg'],start,end),/known Polar fields/);
  const ended=f.read(['sleep_score'],Date.parse('2026-11-12T12:30:00Z'),end);assert.equal(ended.status,'empty');
});

test('activity samples with offsets match exact interval edges; unknown source times remain possible candidates',async t=>{
  const day='2026-11-12',start=Date.parse(day+'T00:00:00Z');
  const activity=act(day+'T00:00:00+09:00',{steps:123,samples:{activity_zones:{samples:[
    {timestamp:day+'T01:00:00+01:00',zone:'LIGHT'}, {timestamp:day+'T00:01:00Z',zone:'VIGOROUS'},
    {timestamp:day+'T18:00:00Z',zone:'MODERATE'},{timestamp:day+'T03:00:00',zone:'SLEEP'},
  ]}}});
  let calls=0;
  const f=await fixture(t,[activity],()=>{calls++;return {evidence:{status:'unavailable'}};});
  const morning=f.read(['activity_zone_samples'],start,start+60_000);
  assert.deepEqual(morning.entries[0].fields.activity_zone_samples,[{time:day+'T01:00:00+01:00',zone:'LIGHT'},{time:day+'T03:00:00',zone:'SLEEP'}]);
  assert.equal(morning.entries[0].sample_coverage!.possible_or_exact_matches,2);assert.equal(calls,1);
  const evening=f.read(['activity_zone_samples'],start+18*hour,start+19*hour);
  assert.deepEqual(evening.entries[0].fields.activity_zone_samples,[{time:day+'T18:00:00Z',zone:'MODERATE'}]);assert.equal(calls,1);
  assert.ok(!('phone_time_evidence' in evening));
  const possibleStart=start-14*hour,possibleEnd=start+36*hour;
  assert.equal(f.read(['steps'],possibleStart-1,possibleStart).status,'empty');
  assert.equal(f.read(['steps'],possibleStart,possibleStart+1).status,'available');
  assert.equal(f.read(['steps'],possibleEnd,possibleEnd+1).status,'empty');
});

test('historical field and time selection precede row cap, compact pages preserve missing values and block stale cursors',async t=>{
  const records=Array.from({length:100},(_,i)=>act(iso(now-100*60_000+i*60_000),{daily_activity:i, ...(i===99?{}:{steps:i})}));
  const older=normalize('recovery',{recharges:[{date:'2026-11-11',heart_rate_avg:63}]},now);
  const f=await fixture(t,[...records,...older]);
  const prior=f.read(['heart_rate_avg'],Date.parse('2026-11-11T03:00:00Z'),Date.parse('2026-11-11T04:00:00Z'));
  assert.deepEqual(prior.entries.map(x=>x.fields),[{heart_rate_avg:63}]);assert.equal(prior.entries[0].measured_at,null);
  const first=f.read(['steps'],now-hour,now,2);assert.equal(first.coverage!.matching_retained_records,100);assert.ok(first.next_cursor);
  assert.deepEqual(first.entries[0].missing_fields,['steps']);
  const second=f.context.readSelectedHistory({cursor:first.next_cursor});assert.ok('coverage' in second);
  assert.ok(second.next_cursor);assert.equal(second.entries.length,2);assert.ok(!first.entries.some(x=>x.id===second.entries[0].id));
  assert.deepEqual(second.entries[0].fields,{steps:97});
  f.advance(5*60_000);assert.throws(()=>f.context.readSelectedHistory({cursor:second.next_cursor!}),/expired/);
  f.authorize(false);assert.equal(f.context.historyOwner(),undefined);assert.equal(f.context.readSelectedHistory({cursor:first.next_cursor}).status,'unavailable');
});

test('Polar sample summary retains units and computation basis; earliest health, token or phone expiry fences further use',async t=>{
  let allowed=true;
  const f=await fixture(t,[heart('2026-11-14'),heart('2026-11-13')],()=>({evidence:{status:'unavailable'},expiresAt:now+1000,allowed:()=>allowed}),now+2000);
  const page=f.read(['heart_rate_summary'],now-4*24*hour,now,1);
  assert.ok(page.next_cursor);assert.match(page.units!.heart_rate_summary,/bpm/);
  assert.equal((page.entries[0].fields.heart_rate_summary as {basis:string}).basis,'all_valid_returned_samples');
  assert.equal(page.response_context!.expires_no_later_than,iso(now+1000));assert.equal(f.context.responseGuard(page.read_id!)(),true);
  allowed=false;assert.throws(()=>f.context.readSelectedHistory({cursor:page.next_cursor!}),/phone-clock evidence/);allowed=true;
  f.advance(1000);assert.throws(f.context.responseGuard(page.read_id!));f.advance(1000);assert.equal(f.context.historyOwner(),undefined);
  const token=await fixture(t,[act(iso(now-hour),{steps:1})],undefined,now+400);
  assert.equal(token.read(['steps']).response_context!.expires_no_later_than,iso(now+400));
  const aboutToExpire=await fixture(t,[act(iso(now-RETENTION+100),{steps:23}),act(iso(now-hour),{steps:21})]);
  const p=aboutToExpire.read(['steps'],now-RETENTION,now,1);assert.ok(p.next_cursor);
  assert.equal(p.response_context!.expires_no_later_than,iso(now+100));
  aboutToExpire.advance(100);assert.throws(aboutToExpire.context.responseGuard(p.read_id!));
});

test('dense Polar fields page at the byte ceiling, retained counts remain explicit, delete invalidates receipts and continuation',async t=>{
  const activity=act('2026-11-12T00:00:00Z',{steps:3,samples:{activity_zones:{samples:Array.from({length:400},(_,i)=>({
    timestamp:iso(Date.parse('2026-11-12T00:00:00Z')+i*1000),zone:'LIGHT'}))}}});
  const repeated=Array.from({length:50},(_,i)=>({...activity,id:i.toString(16).padStart(64,'0')}));
  const f=await fixture(t,repeated);
  const p=f.read(['activity_zone_samples'],Date.parse('2026-11-12T00:00:00Z'),Date.parse('2026-11-13T00:00:00Z'));
  assert.ok(p.next_cursor);assert.ok(p.entries.length>0&&p.entries.length<50);assert.ok(Buffer.byteLength(JSON.stringify(p))<=48*1024);
  assert.equal(p.coverage!.matching_retained_records,50);
  const epoch=f.context.status('owner').healthEpoch;await f.context.control({protocol:1,epoch,action:'delete'},'owner');
  assert.throws(f.context.responseGuard(p.read_id!));assert.equal(f.context.readSelectedHistory({cursor:p.next_cursor}).status,'unavailable');
});
