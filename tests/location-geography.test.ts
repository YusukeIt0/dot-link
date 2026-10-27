import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {LocationContext} from '../server/location.ts';
import {LocalGeography} from '../server/geography/loader.ts';
import {GeographicCache} from '../server/geography/cache.ts';
import {geographicRegion} from '../server/geography/overture.ts';
import {Bridge} from '../server/bridge.ts';
import {rpc} from '../server/http.ts';
import {WebhookSender} from '../server/webhook.ts';
import type {GeographyUpdate,GeographyState} from '../server/geography/loader.ts';
import type {GeographicEvidence,GeographicFix} from '../server/geography/types.ts';

const owner='a'.repeat(64);
const subscription={name:'location.updated',arguments:{session_id:'personal-g2'},delivery:{mode:'webhook',url:'https://callback.example.test/location',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function evidence(names=['Synthetic Park']):GeographicEvidence {
 return {source:'Overture Maps',release:'2026-10-21.0',attribution:'Synthetic fixture',license_url:'https://docs.overturemaps.org/attribution/',limitations:[],areas:names.map(name=>({id:name,kind:'park',name,relation:'within_mapped_area',distance_m:0})),lines:[],landmarks:[]};
}
function fixture(t:TestContext) {
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.UTC(2026,9,27)});
 const directory=mkdtempSync(join(tmpdir(),'dot-location-geography-')),path=join(directory,'location.json');
 const events:any[]=[],inputs:GeographicFix[]=[],announcements:any[]=[];
 let output:(update:GeographyUpdate)=>void=()=>{},stops=0,closed=0,authorized=true,sequence=0;
 const sender=new WebhookSender(async(_url,raw)=>{const event=JSON.parse(raw);if(event.type==='verification')return {status:200,body:JSON.stringify({challenge:event.challenge})};events.push(event);return {status:202,body:'{}'};});
 const context=new LocationContext(path,sender,['callback.example.test'],async(input,guard)=>{guard();announcements.push(input);return {stored_for_g2:true};},()=>Date.now(),()=>authorized,
  callback=>{output=callback;return {update:fix=>inputs.push({...fix}),stop:()=>{stops++;},close:()=>{closed++;}};});
 const sharing=randomUUID();
 const fix=(latitude=10)=>({latitude,longitude:20,accuracy:5,measured_at:new Date().toISOString()});
 const update=(latitude=10)=>context.update({sharing_id:sharing,sequence:++sequence,fix:fix(latitude)},owner);
 const heartbeat=()=>context.update({sharing_id:sharing,sequence:++sequence},owner);
 const enable=()=>context.control({sharing_id:sharing,enabled:true},owner);
 const disable=()=>context.control({sharing_id:sharing,enabled:false},owner);
 const emit=(data:GeographicEvidence|undefined=evidence(),state:GeographyState='ready',point:GeographicFix|undefined=inputs.at(-1))=>output({fix:point,evidence:data,state,revision:state});
 const advance=async(ms:number)=>{t.mock.timers.tick(ms);await flush();};
 const start=async(ttlMs?:number)=>{enable();update();await context.subscribe({...subscription,ttlMs});await flush();};
 t.after(()=>{context.close();rmSync(directory,{recursive:true,force:true});});
 return {context,path,events,inputs,announcements,fix,update,heartbeat,enable,disable,emit,advance,start,output:()=>output,
  revoke:()=>{authorized=false;context.status();},stops:()=>stops,closed:()=>closed};
}

test('coordinates return immediately; acquisition requires consent, a fresh fix and an active Dot subscription',async t=>{
 const f=fixture(t);f.enable();f.update();assert.equal(f.inputs.length,0);
 const before=f.context.read().context!;assert.equal(before.latitude,10);assert.equal(before.geography,undefined);
 await f.context.subscribe(subscription);await flush();assert.equal(f.inputs.length,1);
 const pending=f.context.read().context!;assert.equal(pending.geography?.status,'pending');
 f.emit();const enriched=f.context.read().context!;
 assert.notEqual(enriched.context_id,pending.context_id);assert.equal(enriched.received_at,pending.received_at);
 assert.equal(enriched.geography?.areas?.[0].name,'Synthetic Park');assert.equal(pending.geography?.status,'pending');
 assert.doesNotMatch(readFileSync(f.path,'utf8'),/Synthetic Park|measured_at|geography|latitude|longitude/);
});

test('late stationary geography gets a new decision after an earlier silent response and respects event rate limits',async t=>{
 const f=fixture(t);await f.start();const original=f.context.read().context!;
 const silent=await f.context.respond({context_id:original.context_id,disposition:'silent'});
 await f.advance(5000);f.emit();const enriched=f.context.read().context!;
 assert.notEqual(enriched.context_id,original.context_id);assert.equal(f.events.length,1);
 await f.advance(24_999);assert.equal(f.events.length,1);
 await f.advance(1);assert.equal(f.events.length,2);
 assert.deepEqual(await f.context.respond({context_id:original.context_id,disposition:'silent'}),silent);
 await f.context.respond({context_id:enriched.context_id,disposition:'announce',text:'Synthetic acceptance message'});
 assert.equal(f.announcements.length,1);
 f.emit();await f.advance(30_000);assert.equal(f.events.length,2);
});

test('several geographic phases coalesce while Dot considers the initial coordinate-only event',async t=>{
 const f=fixture(t);await f.start();const original=f.context.read().context!;
 await f.advance(5000);f.emit(evidence(['First area']),'pending');
 await f.advance(5000);f.emit(evidence(['First area','River area']),'ready');
 assert.equal(f.events.length,1);
 await f.context.respond({context_id:original.context_id,disposition:'silent'});
 await f.advance(20_000);assert.equal(f.events.length,2);
 assert.equal(f.context.read().context!.geography?.areas?.length,2);
});

test('an older read response cannot consume a newer geography event already delivered to Dot',async t=>{
 const f=fixture(t);await f.start();
 await f.advance(60_000);f.update();await f.advance(40_000);f.update();
 const old=f.context.read().context!;f.emit();await f.advance(20_000);
 assert.equal(f.events.length,2);const updateId=f.context.read().context!.update_id;assert.ok(updateId);
 await f.context.respond({context_id:old.context_id,disposition:'silent'});
 assert.equal(f.context.read().context!.update_id,updateId);
});

test('small movements and unchanged cached references update distances without repeated geography notifications',async t=>{
 const f=fixture(t);await f.start();f.emit();const first=f.context.read().context!;
 await f.context.respond({context_id:first.context_id,disposition:'silent'});
 await f.advance(35_000);f.update(10.00001);f.emit();await flush();
 assert.equal(f.events.length,1);assert.equal(f.context.read().context!.geography?.status,'ready');
 const changed=evidence();changed.areas[0].distance_m=1;f.emit(changed);await flush();
 assert.equal(f.events.length,1);
});

test('a moved fix rejects late results for an earlier coordinate and preserves the phone arrival time',async t=>{
 const f=fixture(t);await f.start();const old={...f.inputs.at(-1)!};
 await f.advance(1000);f.update(10.01);const before=f.context.read().context!;
 f.emit(evidence(['Wrong old area']),'ready',old);
 assert.equal(f.context.read().context!.geography?.areas,undefined);
 f.emit(evidence(['Current area']));const after=f.context.read().context!;
 assert.equal(after.geography?.areas?.[0].name,'Current area');assert.equal(after.received_at,before.received_at);
});

test('worker failure keeps existing matching references identifiable as partial',async t=>{
 const f=fixture(t);await f.start();f.emit();
 f.output()({state:'unavailable',revision:'worker-failed'});
 const context=f.context.read().context!;assert.equal(context.geography?.status,'partial');assert.equal(context.geography?.areas?.[0].name,'Synthetic Park');
});

for(const reason of ['off','revoked','lease','measurement','subscription','unsubscribe','close'] as const)test(`${reason} stops acquisition and rejects late geography without another phone update`,async t=>{
 const f=fixture(t);await f.start(reason==='subscription'?1000:undefined);const fix={...f.inputs.at(-1)!};
 if(reason==='off')f.disable();
 if(reason==='revoked')f.revoke();
 if(reason==='lease')await f.advance(90_000);
 if(reason==='measurement'){await f.advance(60_000);f.heartbeat();await f.advance(30_001);}
 if(reason==='subscription')await f.advance(1000);
 if(reason==='unsubscribe')await f.context.unsubscribe({...subscription,delivery:{mode:'webhook',url:subscription.delivery.url}});
 if(reason==='close')f.context.close();
 assert.ok(f.stops()>=1);const count=f.events.length;
 f.emit(evidence(['Late forbidden area']),'ready',fix);await flush();
 assert.equal(f.events.length,count);assert.equal(f.context.read().context?.geography,undefined);
});

test('empty coverage and initial acquisition failure keep coordinates without an extra geography event',async t=>{
 const f=fixture(t);await f.start();const original=f.context.read().context!;
 await f.context.respond({context_id:original.context_id,disposition:'silent'});
 f.output()({fix:f.inputs.at(-1),state:'unavailable',revision:'failed'});
 assert.equal(f.context.read().context!.geography?.status,'unavailable');
 assert.equal(f.context.read().context!.latitude,10);
 f.emit(evidence([]));await f.advance(30_000);assert.equal(f.events.length,1);
 assert.deepEqual(f.context.read().context!.geography?.areas,[]);
 f.disable();f.emit(evidence(['Late']));assert.equal(f.context.read().context,null);
});

test('the real cached worker reaches MCP text and structured location context without replacing ordinary message tools',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'dot-location-real-worker-'));
 let context:LocationContext|undefined;
 try {
  const fix={latitude:.005,longitude:.005,accuracy:5,measured_at:new Date().toISOString()};
  const maps=join(directory,'geography');
  await new GeographicCache(maps).put(`normalized-${geographicRegion(fix)!.key}`,Buffer.from(JSON.stringify({source:'Overture Maps',release:'2026-10-21.0',attribution:'Synthetic map',license_url:'https://docs.overturemaps.org/attribution/',limitations:[],features:[{id:'land:peak',kind:'peak',category:'landmark',name:'Synthetic Summit',geometry:{type:'Point',coordinates:[.006,.005]}}]})));
  const sender=new WebhookSender(async(_url,raw)=>{const event=JSON.parse(raw);return event.type==='verification'?{status:200,body:JSON.stringify({challenge:event.challenge})}:{status:202,body:'{}'};});
  const bridge=new Bridge(join(directory,'bridge.json'),sender,['callback.example.test']);
  context=new LocationContext(join(directory,'location.json'),sender,['callback.example.test'],async()=>({stored_for_g2:true}),Date.now,()=>true,output=>new LocalGeography(maps,output));
  const sharing_id=randomUUID();context.control({sharing_id,enabled:true},owner);context.update({sharing_id,sequence:1,fix},owner);
  await context.subscribe(subscription);
  for(let i=0;i<200&&context.read().context?.geography?.status!=='ready';i++)await new Promise(resolve=>setTimeout(resolve,10));
  const result:any=await rpc(bridge,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_location_context',arguments:{}}},undefined,context);
  assert.equal(result.result.structuredContent.context.geography.status,'ready');
  assert.equal(result.result.structuredContent.context.geography.landmarks[0].name,'Synthetic Summit');
  assert.deepEqual(JSON.parse(result.result.content[0].text),result.result.structuredContent);
  const message:any=await rpc(bridge,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'send_message_to_g2',arguments:{message_id:randomUUID(),text:'Ordinary conversation fixture'}}},undefined,context);
  assert.equal(message.error,undefined);assert.equal(bridge.outboundHistory().length,1);
 }finally{context?.close();await new Promise(resolve=>setTimeout(resolve,300));rmSync(directory,{recursive:true,force:true});}
});

test('responding to a newer coordinate-only read consumes the older geographic event and allows the next move',async t=>{
 const f=fixture(t);await f.start();f.emit();
 await f.context.respond({context_id:f.context.read().context!.context_id,disposition:'silent'});
 await f.advance(30_000);f.emit(evidence(['New reference']));await flush();assert.equal(f.events.length,2);
 await f.advance(1000);f.update(10.0006);const current=f.context.read().context!;
 assert.equal(current.geography?.status,'pending');
 await f.context.respond({context_id:current.context_id,disposition:'silent'});
 assert.equal(f.context.read().context!.update_id,null);
 await f.advance(30_000);f.update(10.0012);await flush();assert.equal(f.events.length,3);
});
