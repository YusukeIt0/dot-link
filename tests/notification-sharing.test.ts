import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {Bridge} from '../server/bridge.ts';
import {NotificationInbox} from '../server/notifications.ts';
import {SharingActivation} from '../server/sharing-activation.ts';
import {WebhookSender} from '../server/webhook.ts';
import {rpc} from '../server/http.ts';
import {LocationContext} from '../server/location.ts';
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'notification-sharing-'));
  let now = Date.now(), response = 202;
  const events: any[] = [];
  const hosts = ['callback.example.test'];
  const sender = new WebhookSender(async (_url, raw) => {
    const event = JSON.parse(raw);
    if (event.type === 'verification') return {status: 200, body: JSON.stringify({challenge: event.challenge})};
    events.push(event); return {status: event.name === 'notification.created' ? response : 202, body: '{}'};
  });
  const voice = {name:'utterance.created', arguments:{session_id:'personal-g2'}, delivery:{mode:'webhook',url:'https://callback.example.test/voice',secret:'whsec_'+randomBytes(32).toString('base64')}};
  const notification = {...voice,name:'notification.created',delivery:{...voice.delivery,url:'https://callback.example.test/notifications'}};
  const bridge = new Bridge(join(root,'bridge.json'),sender,hosts);
  const inbox = new NotificationInbox(join(root,'notifications.json'),sender,hosts,()=>now);
  const activation = new SharingActivation(join(root,'activation.json'),bridge,inbox,()=>now,'notification');
  let id = randomUUID(), epoch = randomUUID(), wasEnabled = false;
  const control = (enabled = true, fresh = false) => {
    if (fresh) id = randomUUID();
    if (enabled && (!wasEnabled || fresh)) epoch = randomUUID();
    wasEnabled = enabled;
    writeFileSync(join(root,'notification-sharing.json'),JSON.stringify({version:1,id,epoch,enabled,updatedAt:now}),{mode:0o600});
  };
  const payload = () => ({id:randomUUID(),source_app:'Fixture',title:'Synthetic notification',body:'Test only',observed_at:new Date(now).toISOString(),source_verification:'synthetic-test-marker',sharing_id:epoch});
  return {root,voice,notification,bridge,inbox,activation,events,control,payload,sender,hosts,now:()=>now,
    advance:(ms:number)=>{now+=ms;}, response:(status:number)=>{response=status;},
    close:()=>{activation.close();inbox.close();bridge.close();rmSync(root,{recursive:true,force:true});}};
}
test('enabled notifications activate the existing Dot without another owner instruction or G2 confirmation',async t=>{
  const f=fixture();t.after(f.close);await f.bridge.subscribe(f.voice);
  f.control();await f.activation.sync();
  assert.equal(f.events.length,1);assert.match(f.events[0].data.text,/Mac notification sharing/);
  const request:any=await rpc(f.bridge,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_pending_utterances'}},f.inbox,undefined,undefined,undefined,[f.activation]);
  const control=request.result.structuredContent.utterances[0];
  assert.equal(control.event,'notification.created');assert.equal(control.source,'owner_sharing_control');
  assert.match(control.text,/untrusted third-party/);
  assert.throws(()=>f.activation.acknowledge('reply_to_g2',{utterance_id:control.utterance_id,text:'ready'}),{reason:'sharing_activation_pending'});
  await f.inbox.subscribe(f.notification);await settle();
  const ack:any=await rpc(f.bridge,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'reply_to_g2',arguments:{utterance_id:control.utterance_id,text:'ready'}}},f.inbox,undefined,undefined,undefined,[f.activation]);
  assert.equal(ack.result.structuredContent.delivered_to_g2,false);
  assert.equal(f.inbox.status().notificationSubscribed,true);assert.equal(f.bridge.status().subscribed,true);
  assert.deepEqual(f.bridge.history(),[]);assert.deepEqual(f.bridge.outboundHistory(),[]);
  await f.inbox.submit(f.payload());assert.equal(f.events[1].name,'notification.created');
});
test('sharing before connection and already-prepared reception need no manual setup or duplicate control',async t=>{
  const f=fixture();t.after(f.close);f.control();await f.activation.sync();assert.equal(f.events.length,0);
  await f.inbox.subscribe(f.notification);await f.bridge.subscribe(f.voice);await settle();
  assert.equal(f.events.length,0);assert.deepEqual(f.activation.pending(),[]);
});
test('stop, stale heartbeat, corrupt control and removed control fail closed, including after relay restart',async t=>{
  for(const mode of ['stop','expired','corrupt','removed'] as const) await t.test(mode,async t=>{
    const f=fixture();t.after(f.close);f.control();await f.bridge.subscribe(f.voice);await f.activation.sync();
    assert.equal(f.activation.pending().length,1);await f.inbox.subscribe(f.notification);
    if(mode==='stop')f.control(false);
    if(mode==='expired')f.advance(30_001);
    if(mode==='corrupt')writeFileSync(join(f.root,'notification-sharing.json'),'invalid');
    if(mode==='removed')rmSync(join(f.root,'notification-sharing.json'));
    assert.deepEqual(f.activation.pending(),[]);await assert.rejects(f.inbox.submit(f.payload()),/sharing is stopped/);
    f.inbox.close();
    const restored=new NotificationInbox(join(f.root,'notifications.json'),new WebhookSender(async()=>({status:200,body:'{}'})),[],()=>Date.now()+60_000);t.after(()=>restored.close());
    await assert.rejects(restored.submit(f.payload()),/sharing is stopped/);
    assert.equal(restored.status().notificationCount,0);
  });
});
test('explicit Dot unsubscribe stays stopped across pause, heartbeat and relay restart until a new sharing choice',async t=>{
  const f=fixture();t.after(f.close);f.control();await f.bridge.subscribe(f.voice);await f.activation.sync();await f.inbox.subscribe(f.notification);await settle();
  f.control(false);
  await f.inbox.unsubscribe({name:f.notification.name,arguments:f.notification.arguments,delivery:{mode:'webhook',url:f.notification.delivery.url}});
  f.control();await f.activation.sync();assert.deepEqual(f.activation.pending(),[]);assert.equal(f.events.length,1);assert.equal(f.inbox.status().notificationReception,'stopped');
  const saved=JSON.parse(readFileSync(join(f.root,'notifications.json'),'utf8'));assert.ok(saved.activationStoppedFor);
  f.activation.close(); f.inbox.close();
  const restored=new NotificationInbox(join(f.root,'notifications.json'),f.sender,f.hosts,f.now);
  const activation=new SharingActivation(join(f.root,'activation.json'),f.bridge,restored,f.now,'notification');
  t.after(()=>{activation.close();restored.close();});
  await activation.sync();assert.deepEqual(activation.pending(),[]);assert.equal(f.events.length,1);
  f.control(true,true);await activation.sync();assert.equal(f.events.length,2);assert.equal(activation.pending().length,1);
});
test('expiry and a gone notification callback recover through the unchanged conversation connection',async t=>{
  for(const mode of ['expire','gone'] as const) await t.test(mode,async t=>{
    const f=fixture();t.after(f.close);f.control();await f.bridge.subscribe(f.voice);await f.activation.sync();
    await f.inbox.subscribe({...f.notification,ttlMs:1000});await settle();
    if(mode==='expire')f.advance(1001);
    else {f.response(410);await f.inbox.submit(f.payload());}
    await f.activation.sync();
    assert.equal(f.bridge.status().subscribed,true);assert.equal(f.inbox.status().notificationSubscribed,false);
    assert.equal(f.events.filter(e=>e.name==='utterance.created').length,2);assert.equal(f.activation.pending().length,1);
  });
});
test('no subscription retains the existing drop policy; legacy collectors migrate only when native control appears',async t=>{
  const f=fixture();t.after(f.close);await assert.rejects(f.inbox.submit(f.payload()),/No notification subscription/);assert.equal(f.inbox.status().notificationCount,0);
  await f.inbox.subscribe(f.notification);await f.inbox.submit(f.payload());assert.equal(f.inbox.status().notificationCount,1);
  f.control(false);await assert.rejects(f.inbox.submit(f.payload()),/sharing is stopped/);
  assert.equal(f.inbox.status().notificationCount,1);
});

test('explicit synthetic diagnostics remain separate from ordinary sharing and cannot activate Dot',async t=>{
  const f=fixture();t.after(f.close);f.control(false);await f.bridge.subscribe(f.voice);await f.inbox.subscribe(f.notification);
  await f.inbox.submit({...f.payload(),source_app:'Dot Notification Lab',title:'DOT-LAB-1234ABCD'});
  await f.activation.sync();assert.deepEqual(f.activation.pending(),[]);assert.equal(f.events.filter(e=>e.name==='utterance.created').length,0);
  await assert.rejects(f.inbox.submit({...f.payload(),source_app:'Dot Notification Lab',title:'DOT-LAB-1234ABCD',source_verification:'accessibility'}),/sharing is stopped/);
});

test('location and notification controls coexist in the bounded input envelope without replacing conversation',async t=>{
  const f=fixture();t.after(f.close);
  const locations=new LocationContext(join(f.root,'locations.json'),f.sender,f.hosts,(input,guard,context)=>f.bridge.sendMessage(input,guard,context),f.now,()=>true);
  const activation=new SharingActivation(join(f.root,'location-activation.json'),f.bridge,locations,f.now);
  t.after(()=>{activation.close();locations.close();});
  await f.bridge.subscribe(f.voice);f.control();locations.control({sharing_id:randomUUID(),enabled:true},'a'.repeat(64));
  await activation.sync();await f.activation.sync();
  for(let i=0;i<10;i++)await f.bridge.submit({id:randomUUID(),text:`Question ${i}`});
  const result:any=await rpc(f.bridge,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_pending_utterances'}},f.inbox,locations,undefined,undefined,[activation,f.activation]);
  const rows=result.result.structuredContent.utterances;
  assert.equal(rows.length,10);assert.deepEqual(rows.slice(0,2).map((row:any)=>row.event),['location.updated','notification.created']);
  assert.equal(f.bridge.history()[8].readAt,undefined);
  f.control(false);assert.deepEqual(f.activation.pending(),[]);assert.equal(activation.pending().length,1);
});

test('a notification captured before stop cannot cross a new sharing choice, while an accepted retry stays idempotent',async t=>{
  const f=fixture();t.after(f.close);f.control();await f.inbox.subscribe(f.notification);
  const stale=f.payload(), accepted=f.payload();await f.inbox.submit(accepted);
  f.control(false);f.control(true,true);
  await assert.rejects(f.inbox.submit(stale),/sharing is stopped/);
  const {sharing_id: _id,...missing}=f.payload();await assert.rejects(f.inbox.submit(missing),/sharing is stopped/);
  await f.inbox.submit(accepted);assert.equal(f.events.length,1);
  await f.inbox.submit(f.payload());assert.equal(f.events.length,2);
  const stored=JSON.parse(readFileSync(join(f.root,'notifications.json'),'utf8'));
  assert.ok(stored.notifications.every((item:any)=>!Object.hasOwn(item,'sharing_id')));
});

test('pause and resume fence earlier notifications without making a new sharing choice',async t=>{
  const f=fixture();t.after(f.close);f.control();await f.inbox.subscribe(f.notification);
  const stale=f.payload();f.control(false);f.control();
  await assert.rejects(f.inbox.submit(stale),/sharing is stopped/);
  await f.inbox.submit(f.payload());assert.equal(f.events.length,1);
});
