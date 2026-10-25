import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { PHOTO_RETENTION, photoDigest } from '../server/photo-attachments.ts';
import { photoFixture } from './photo-fixture.ts';
import { Bridge } from '../server/bridge.ts';
import { authorized, rpc } from '../server/http.ts';
import { WebhookSender, callbackUrl, publicAddress, type Post } from '../server/webhook.ts';

const secret = 'whsec_' + randomBytes(32).toString('base64');
const subscription = {
  name: 'utterance.created', arguments: { session_id: 'personal-g2' },
  delivery: { mode: 'webhook', url: 'https://callback.example.test/events', secret }, cursor: null,
};
function setup(post?: Post, options?: ConstructorParameters<typeof Bridge>[4]) {
  const directory = mkdtempSync(join(tmpdir(), 'g2-bridge-test-'));
  const path = join(directory, 'state.json');
  const events: Record<string, unknown>[] = [];
  const sender = new WebhookSender(post ?? (async (_url, body, headers) => {
    // Validate the wire signature, not just the returned status.
    const decoded = new Webhook(secret).verify(body, headers) as Record<string, unknown>;
    if (decoded.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: decoded.challenge }) };
    events.push(decoded); return { status: 202, body: '{}' };
  }));
  const hosts = ['callback.example.test'];
  const bridge = new Bridge(path, sender, hosts, undefined, options);
  return { path, events, sender, hosts, bridge, close: () => { bridge.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('verified subscription delivers an event and the reply is correlated, persistent, and idempotent', async t => {
  const s = setup(); t.after(s.close);
  await s.bridge.subscribe(subscription);
  const id = randomUUID();
  const message = await s.bridge.submit({ id, text: '接続確認' });
  assert.equal(message.status, 'accepted');
  assert.equal(message.reply, undefined); // HTTP receipt is not a Dot reply.
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0].data, { session_id: 'personal-g2', utterance_id: id, text: '接続確認' });
  assert.deepEqual(s.bridge.pending().utterances.map(item => [item.utterance_id, item.text]), [[id, '接続確認']]);
  await s.bridge.submit({ id, text: '接続確認' });
  assert.equal(s.events.length, 1);
  await assert.rejects(s.bridge.reply({ utterance_id: randomUUID(), text: 'wrong message' }));
  await s.bridge.reply({ utterance_id: id, text: '受信しました' });
  assert.deepEqual(s.bridge.pending().utterances, []);
  await s.bridge.reply({ utterance_id: id, text: '受信しました' });
  await assert.rejects(s.bridge.reply({ utterance_id: id, text: 'overwrite' }));
  const reloaded = new Bridge(s.path, s.sender, s.hosts);
  assert.equal(reloaded.status().subscribed, true);
  assert.equal(reloaded.history()[0].reply, '受信しました');
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
});

test('failed challenge never activates a subscriber and sends no application data', async t => {
  const sent: unknown[] = [];
  const s = setup(async (_url, body) => { sent.push(JSON.parse(body)); return { status: 200, body: '{"challenge":"wrong"}' }; });
  t.after(s.close);
  await assert.rejects(s.bridge.subscribe(subscription));
  await assert.rejects(s.bridge.submit({ id: randomUUID(), text: 'must not leave' }));
  assert.equal(s.bridge.status().subscribed, false);
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { type: string }).type, 'verification');
});

test('session mismatch, second subscriber, unsubscribe, and expiry prevent unintended delivery', async t => {
  const s = setup(); t.after(s.close);
  await assert.rejects(s.bridge.subscribe({ ...subscription, arguments: { session_id: 'someone-else' } }));
  await s.bridge.subscribe(subscription);
  await assert.rejects(s.bridge.subscribe({ ...subscription, delivery: { ...subscription.delivery, url: 'https://callback.example.test/other' } }));
  await s.bridge.unsubscribe({ name: subscription.name, arguments: subscription.arguments, delivery: { mode: 'webhook', url: subscription.delivery.url } });
  await assert.rejects(s.bridge.submit({ id: randomUUID(), text: 'stopped' }));
  await s.bridge.subscribe(subscription);
  const state = JSON.parse(readFileSync(s.path, 'utf8')); state.subscription.expiresAt = 0;
  writeFileSync(s.path, JSON.stringify(state));
  const expired = new Bridge(s.path, s.sender, s.hosts);
  await assert.rejects(expired.submit({ id: randomUUID(), text: 'expired' }));
  assert.equal(s.events.length, 0);
});

test('a webhook timeout remains uncertain and retries with the same ID do not duplicate delivery', async t => {
  let deliveries = 0;
  const s = setup(async (_url, body) => {
    const value = JSON.parse(body);
    if (value.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: value.challenge }) };
    deliveries++; throw new Error('timeout after peer may have received event');
  }); t.after(s.close);
  await s.bridge.subscribe(subscription);
  const input = { id: randomUUID(), text: 'one event' };
  assert.equal((await s.bridge.submit(input)).status, 'failed');
  await s.bridge.submit(input);
  assert.equal(deliveries, 1);
  // A real reply can still arrive after an ambiguous timeout.
  await s.bridge.reply({ utterance_id: input.id, text: 'delayed reply' });
  assert.equal(s.bridge.history()[0].status, 'replied');
});

test('callback validation rejects local destinations, credentials, unlisted hosts, and non-HTTPS', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '::1', '::ffff:192.168.1.1', 'fe80::1', '192.0.2.1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('1.1.1.1'), true);
  for (const url of ['http://callback.example.test/a', 'https://evil.example/a', 'https://user:password@callback.example.test/a', 'https://callback.example.test:444/a']) {
    assert.throws(() => callbackUrl(url, ['callback.example.test']));
  }
  assert.throws(() => callbackUrl('https://callback.example.test/a', []));
});

test('RPC limits tools to status, pending utterances and replies and never exposes secrets', async t => {
  const s = setup(); t.after(s.close);
  const listed = await rpc(s.bridge, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['get_status', 'get_pending_utterances', 'reply_to_g2', 'send_message_to_g2']);
  const status = await rpc(s.bridge, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {}, _meta: { progressToken: 3 } } }) as { result: { structuredContent: unknown } };
  assert.deepEqual(status.result.structuredContent, { subscribed: false, messageCount: 0, sessionId: 'personal-g2' });
  const error = await rpc(s.bridge, { jsonrpc: '2.0', id: 2, method: 'events/subscribe', params: { ...subscription, delivery: { ...subscription.delivery, url: 'https://evil.example/' } } });
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(authorized(`Bearer ${'x'.repeat(32)}`, 'x'.repeat(32)), true);
  assert.equal(authorized('Bearer incorrect', 'x'.repeat(32)), false);
});


test('Dot sends independent follow-ups without a pending utterance or subscription; retries persist once', async t => {
  const s = setup(); t.after(s.close);
  // Load an original version-1 file that has no outbound field.
  writeFileSync(s.path, JSON.stringify({ version: 1, messages: [] }));
  const bridge = new Bridge(s.path, s.sender, s.hosts);
  const first = { message_id: randomUUID(), text: 'Dotからの自発連絡1' };
  const second = { message_id: randomUUID(), text: 'Dotからの自発連絡2' };
  const result = await bridge.sendMessage(first);
  assert.equal(result.stored_for_g2, true);
  assert.equal(result.physical_display_confirmed, false);
  await bridge.sendMessage(second);
  await bridge.sendMessage(first);
  await assert.rejects(bridge.sendMessage({ ...first, text: 'overwrite' }));
  await assert.rejects(bridge.sendMessage({ ...first, utterance_id: randomUUID() }));
  assert.equal(bridge.outboundHistory().length, 2);
  assert.deepEqual(bridge.history(), []);
  assert.deepEqual(bridge.pending().utterances, []);
  assert.equal(s.events.length, 0);
  const reloaded = new Bridge(s.path, s.sender, s.hosts);
  await reloaded.sendMessage(second);
  assert.deepEqual(reloaded.outboundHistory().map(m => m.reply), [first.text, second.text]);
  const viaRpc = await rpc(reloaded, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'send_message_to_g2', arguments: { message_id: randomUUID(), text: 'RPCから3通目' }
  } }) as { result: { structuredContent: { stored_for_g2: boolean } } };
  assert.equal(viaRpc.result.structuredContent.stored_for_g2, true);
  assert.equal(reloaded.outboundHistory().length, 3);
});

test('Dot body retrieval persists a receipt only for returned utterances, without changing send time', async t => {
  const s = setup(); t.after(s.close); await s.bridge.subscribe(subscription);
  const ids = Array.from({length: 11}, () => randomUUID());
  for (const id of ids) await s.bridge.submit({id, text: 'Synthetic follow-up'});
  const sent = s.bridge.history();
  assert.ok(sent.every(item => item.readAt === undefined), 'webhook acceptance and history reads are not receipts');
  let changes = 0; const off = s.bridge.changes.subscribe(() => changes++); t.after(off);
  assert.equal(s.bridge.pending().utterances.length, 10);
  const seen = s.bridge.history();
  assert.ok(seen.slice(0, 10).every(item => item.readAt));
  assert.equal(seen[10].readAt, undefined);
  assert.deepEqual(seen.map(item => item.createdAt), sent.map(item => item.createdAt));
  assert.equal(changes, 1);
  s.bridge.pending(); assert.equal(changes, 1, 'repeated tool reads do not replace the first receipt');
  assert.deepEqual(new Bridge(s.path, s.sender, s.hosts).history(), seen);
  await s.bridge.reply({utterance_id: ids[0], text: 'A reply covering several follow-ups'});
  await s.bridge.submit({id: randomUUID(), text: 'Another follow-up'});
  assert.equal(s.bridge.history().length, 12, 'there is no unresolved-count send cap');
});


test('outbound capacity rotates in acceptance order across legacy load, retries and restart', async t => {
  const s = setup(); t.after(s.close);
  const records = Array.from({length: 1000}, (_, i) => ({message_id: randomUUID(), text: `Synthetic ${i}`, createdAt: new Date(2000 - i).toISOString()}));
  const messages = [{id: randomUUID(), text: 'Existing utterance', status: 'replied', reply: 'Existing reply', createdAt: new Date(0).toISOString()}];
  writeFileSync(s.path, JSON.stringify({version: 1, messages, outbound: records}));
  let bridge = new Bridge(s.path, s.sender, s.hosts);
  let changes = 0; const off = bridge.changes.subscribe(() => changes++); t.after(off);
  const input = (record: typeof records[number]) => ({message_id: record.message_id, text: record.text});
  const before = readFileSync(s.path, 'utf8');
  await bridge.sendMessage(input(records[0]));
  await assert.rejects(bridge.sendMessage({...input(records[0]), text: 'Conflict'}), /Message ID conflicts/);
  assert.equal(readFileSync(s.path, 'utf8'), before);
  assert.equal(changes, 0);
  const additions = Array.from({length: 3}, (_, i) => ({message_id: randomUUID(), text: `New ${i}`}));
  await Promise.all(additions.map(value => bridge.sendMessage(value)));
  assert.equal(changes, 3);
  const expected = [...records.slice(3).map(r => r.message_id), ...additions.map(r => r.message_id)];
  assert.deepEqual(bridge.outboundHistory().map(r => r.id), expected.map(id => `dot:${id}`));
  assert.deepEqual(bridge.history(), messages);
  bridge = new Bridge(s.path, s.sender, s.hosts);
  await bridge.sendMessage(input(records[3]));
  await assert.rejects(bridge.sendMessage({...input(records[3]), text: 'Conflict after restart'}), /Message ID conflicts/);
  assert.deepEqual(bridge.outboundHistory().map(r => r.id), expected.map(id => `dot:${id}`));
  // Evicted IDs have no duplicate/conflict guarantee, with either identical or changed text.
  await bridge.sendMessage(input(records[0]));
  await bridge.sendMessage({...input(records[1]), text: 'New text for an evicted ID'});
  const reloaded = new Bridge(s.path, s.sender, s.hosts);
  assert.equal(reloaded.outboundHistory().length, 1000);
  assert.deepEqual(reloaded.outboundHistory().slice(-2).map(r => [r.id, r.reply]), [[`dot:${records[0].message_id}`, records[0].text], [`dot:${records[1].message_id}`, 'New text for an evicted ID']]);
  assert.deepEqual(reloaded.history(), messages);
  assert.equal(JSON.parse(readFileSync(s.path, 'utf8')).version, 1);
});

test('failed outbound rotation preserves memory and disk and allows a real retry', async t => {
  const s = setup(); t.after(s.close);
  const outbound = Array.from({length: 1000}, (_, i) => ({message_id: randomUUID(), text: `Synthetic ${i}`, createdAt: new Date(0).toISOString()}));
  writeFileSync(s.path, JSON.stringify({version: 1, messages: [], outbound}));
  const bridge = new Bridge(s.path, s.sender, s.hosts);
  const before = readFileSync(s.path, 'utf8');
  let changes = 0; const off = bridge.changes.subscribe(() => changes++); t.after(off);
  const input = {message_id: randomUUID(), text: 'Persist before acknowledging'};
  mkdirSync(`${s.path}.tmp`);
  await assert.rejects(bridge.sendMessage(input));
  assert.equal(readFileSync(s.path, 'utf8'), before);
  assert.equal(bridge.outboundHistory()[0].id, `dot:${outbound[0].message_id}`);
  assert.equal(bridge.outboundHistory().some(r => r.id === `dot:${input.message_id}`), false);
  assert.equal(changes, 0);
  rmSync(`${s.path}.tmp`, {recursive: true});
  const result = await bridge.sendMessage(input);
  assert.equal(result.stored_for_g2, true);
  assert.equal(result.physical_display_confirmed, false);
  assert.equal(changes, 1);
  const reloaded = new Bridge(s.path, s.sender, s.hosts);
  assert.equal(reloaded.outboundHistory().length, 1000);
  assert.equal(reloaded.outboundHistory()[0].id, `dot:${outbound[1].message_id}`);
  assert.equal(reloaded.outboundHistory().at(-1)?.id, `dot:${input.message_id}`);
});


test('location guards still prevent rotation and location metadata survives accepted rotation', async t => {
  const s = setup(); t.after(s.close);
  const outbound = Array.from({length: 1000}, () => ({message_id: randomUUID(), text: 'Synthetic', createdAt: new Date(0).toISOString()}));
  writeFileSync(s.path, JSON.stringify({version: 1, messages: [], outbound}));
  const bridge = new Bridge(s.path, s.sender, s.hosts);
  const input = {message_id: randomUUID(), text: 'Synthetic location announcement'};
  const location = {sharing_id: randomUUID(), expires_at: new Date(Date.now() + 60000).toISOString()};
  const before = readFileSync(s.path, 'utf8');
  await assert.rejects(bridge.sendMessage(input, () => false, location), /context is no longer valid/);
  assert.equal(readFileSync(s.path, 'utf8'), before);
  await bridge.sendMessage(input, () => true, location);
  const reloaded = new Bridge(s.path, s.sender, s.hosts);
  assert.equal(reloaded.outboundHistory().length, 1000);
  assert.equal(reloaded.outboundHistory().at(-1)?.location_sharing_id, location.sharing_id);
  assert.equal(reloaded.outboundHistory().at(-1)?.location_expires_at, location.expires_at);
  const value = await rpc(reloaded, {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'send_message_to_g2', arguments: {message_id: randomUUID(), text: 'New via RPC at capacity'}
  }}) as {result: {structuredContent: {stored_for_g2: boolean}}};
  assert.equal(value.result.structuredContent.stored_for_g2, true);
  assert.equal(reloaded.outboundHistory().length, 1000);
});

const syntheticPhoto = photoFixture();
test('photo-only messages deliver MCP images, keep binaries off events/history, and delete images after reply', async t => {
  const s = setup(); t.after(s.close); await s.bridge.subscribe(subscription);
  const input = { id: randomUUID(), text: '', photos: [syntheticPhoto] };
  const message = await s.bridge.submit(input);
  assert.equal(message.photoCount, 1);
  assert.equal('photos' in message, false);
  assert.equal(JSON.stringify(s.events).includes(syntheticPhoto.data), false);
  assert.equal(JSON.stringify(s.bridge.history()).includes(syntheticPhoto.data), false);
  const restored = new Bridge(s.path, s.sender, s.hosts);
  const result = await rpc(restored, {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_pending_utterances',arguments:{}}});
  assert.ok(JSON.stringify(result).includes(syntheticPhoto.data));
  const pending = restored.pendingResult();
  assert.deepEqual(pending.content[2], {type:'image', ...syntheticPhoto});
  assert.equal(pending.structuredContent.utterances[0].photo_count, 1);
  assert.equal(JSON.stringify(pending.structuredContent).includes(syntheticPhoto.data), false);
  await restored.reply({utterance_id: input.id, text:'A green image'});
  assert.equal(readFileSync(s.path,'utf8').includes(syntheticPhoto.data), false);
  const afterReply = new Bridge(s.path,s.sender,s.hosts);
  assert.equal((await afterReply.submit(input)).status,'replied');
  assert.equal(s.events.length, 1);
  await assert.rejects(afterReply.submit({...input,photos:[]}));
});

test('photo validation rejects unsupported, malformed, empty and excessive drafts before delivery', async t => {
  const s = setup(); t.after(s.close); await s.bridge.subscribe(subscription);
  for (const photos of [[], Array(5).fill(syntheticPhoto), [{...syntheticPhoto,mimeType:'image/png'}],
    [{...syntheticPhoto,data:'AAAA'}], [{...syntheticPhoto,data:syntheticPhoto.data+'='}],
    [{...syntheticPhoto,path:'/private/photo.jpg'}]]) {
    await assert.rejects(s.bridge.submit({id:randomUUID(),text:'',photos}));
  }
  assert.equal(s.bridge.history().length,0); assert.equal(s.events.length,0);
});

test('pending image batches preserve ordering and expose at most four photos until replies advance them', async t => {
  const s = setup(); t.after(s.close); await s.bridge.subscribe(subscription);
  const first = randomUUID(), second = randomUUID();
  await s.bridge.submit({id:first,text:'First',photos:Array(3).fill(syntheticPhoto)});
  await s.bridge.submit({id:second,text:'Second',photos:Array(2).fill(syntheticPhoto)});
  assert.deepEqual(s.bridge.pending().utterances.map(m=>m.utterance_id),[first]);
  assert.equal(s.bridge.pendingResult().content.filter(c=>c.type==='image').length,3);
  await s.bridge.reply({utterance_id:first,text:'First received'});
  assert.deepEqual(s.bridge.pending().utterances.map(m=>m.utterance_id),[second]);
});

test('pending photo storage is bounded across reload and a reply frees capacity', async t => {
 const policy = { ...PHOTO_RETENTION, maxBytes: 8 * 1024 * 1024 };
 const s=setup(undefined, {photoRetention: policy});t.after(s.close);await s.bridge.subscribe(subscription);
 // Valid JPEG with bounded application segments: test relay limits without a large pixel fixture.
 const photo=photoFixture(512*1024);
 const first=randomUUID();await s.bridge.submit({id:first,text:'',photos:Array(4).fill(photo)});
 for(let i=0;i<3;i++) await s.bridge.submit({id:randomUUID(),text:'',photos:Array(4).fill(photo)});
 const restored=new Bridge(s.path,s.sender,s.hosts,undefined,{photoRetention:policy});t.after(()=>restored.close());
 await assert.rejects(restored.submit({id:randomUUID(),text:'',photos:[syntheticPhoto]}),/storage is full/);
 await restored.reply({utterance_id:first,text:'Received'});
 await restored.submit({id:randomUUID(),text:'',photos:[syntheticPhoto]});
 assert.equal(restored.history().length,5);
});

test('photo retention defaults to 24 hours and 64 MiB; expiry preserves retry identity and informs Dot', async t => {
 assert.equal(PHOTO_RETENTION.maxAgeMs,24*60*60*1000);assert.equal(PHOTO_RETENTION.maxBytes,64*1024*1024);
 let now=Date.now();const s=setup(undefined,{now:()=>now});t.after(s.close);await s.bridge.subscribe(subscription);
 const input={id:randomUUID(),text:'',photos:[syntheticPhoto]};await s.bridge.submit(input);
 now+=PHOTO_RETENTION.maxAgeMs-1;assert.equal(s.bridge.pendingResult().content.filter(c=>c.type==='image').length,1);
 now++;const result=s.bridge.pendingResult();
 assert.equal(result.content.filter(c=>c.type==='image').length,0);
 assert.equal(result.structuredContent.utterances[0].photos_expired,true);
 assert.equal(s.bridge.history()[0].photosExpired,true);assert.equal(s.bridge.history()[0].photoCount,1);
 assert.equal(readFileSync(s.path,'utf8').includes(syntheticPhoto.data),false);
 assert.equal((await s.bridge.submit(input)).photosExpired,true);
 assert.equal(s.events.length,1,'an uncertain retry must not silently resend an expired message');
});

test('restart expires old photos and a reduced policy retires oldest bodies without losing conversations', async t => {
 let now=Date.now();const s=setup(undefined,{now:()=>now});t.after(s.close);await s.bridge.subscribe(subscription);
 const first=randomUUID(),second=randomUUID();
 await s.bridge.submit({id:first,text:'First',photos:[syntheticPhoto]});now+=1000;
 await s.bridge.submit({id:second,text:'Second',photos:[syntheticPhoto]});s.bridge.close();
 const onePhoto=Buffer.byteLength(syntheticPhoto.data,'base64');
 const reduced=new Bridge(s.path,s.sender,s.hosts,undefined,{now:()=>now,photoRetention:{...PHOTO_RETENTION,maxBytes:onePhoto}});t.after(()=>reduced.close());
 assert.equal(reduced.history().length,2);assert.equal(reduced.history()[0].photosExpired,true);
 assert.equal(reduced.pendingResult().content.filter(c=>c.type==='image').length,1);
 reduced.close();now+=PHOTO_RETENTION.maxAgeMs;
 const restarted=new Bridge(s.path,s.sender,s.hosts,undefined,{now:()=>now});t.after(()=>restarted.close());
 assert.equal(restarted.history().length,2);assert.ok(restarted.history().every(m=>m.photosExpired));
 assert.equal(readFileSync(s.path,'utf8').includes(syntheticPhoto.data),false);
});

test('the running relay removes expired photo bodies without a client read', async t => {
 const s=setup(undefined,{photoRetention:{...PHOTO_RETENTION,maxAgeMs:40}});t.after(s.close);await s.bridge.subscribe(subscription);
 await s.bridge.submit({id:randomUUID(),text:'Automatic cleanup',photos:[syntheticPhoto]});
 await new Promise(resolve=>setTimeout(resolve,100));
 const stored=JSON.parse(readFileSync(s.path,'utf8'));
 assert.equal(stored.messages[0].photos,undefined);assert.equal(stored.messages[0].photosExpired,true);
});

test('expiry during webhook delivery cannot restore an image body or lose the delivery status',async t=>{
 let now=Date.now(),release!:()=>void,started!:()=>void;
 const waiting=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{release=r;});
 const s=setup(async(_url,body)=>{const p=JSON.parse(body);if(p.type==='verification')return{status:200,body:JSON.stringify({challenge:p.challenge})};started();await gate;return{status:202,body:'{}'};},{now:()=>now});t.after(s.close);
 await s.bridge.subscribe(subscription);
 const sending=s.bridge.submit({id:randomUUID(),text:'',photos:[syntheticPhoto]});await waiting;
 now+=PHOTO_RETENTION.maxAgeMs;s.bridge.history();release();const result=await sending;
 assert.equal(result.status,'accepted');assert.equal(result.photosExpired,true);
 assert.equal(readFileSync(s.path,'utf8').includes(syntheticPhoto.data),false);
});

test('photo bodies are separate owner-only files, shared until the last reference is released', async t => {
 const s=setup();t.after(s.close);await s.bridge.subscribe(subscription);
 const first=randomUUID(),second=randomUUID();
 await s.bridge.submit({id:first,text:'First',photos:[syntheticPhoto]});
 await s.bridge.submit({id:second,text:'Second',photos:[syntheticPhoto]});
 const stored=JSON.parse(readFileSync(s.path,'utf8'));
 const digest=stored.messages[0].photoFiles[0], body=join(`${s.path}.photos`,digest);
 assert.equal(stored.messages[0].photos,undefined);
 assert.equal(stored.messages[1].photoFiles[0],digest);
 assert.equal(readFileSync(body).toString('base64'),syntheticPhoto.data);
 assert.equal(statSync(body).mode&0o777,0o600);assert.equal(statSync(`${s.path}.photos`).mode&0o777,0o700);
 const modified=statSync(body).mtimeMs;
 await s.bridge.sendMessage({message_id:randomUUID(),text:'Hello'});
 s.bridge.pending();assert.equal(statSync(body).mtimeMs,modified);
 await s.bridge.reply({utterance_id:first,text:'One'});assert.ok(statSync(body).isFile());
 await s.bridge.reply({utterance_id:second,text:'Two'});assert.throws(()=>statSync(body),{code:'ENOENT'});
});

test('failed conversation commit retains live photos; restart removes orphan bodies and migrates inline state', async t => {
 const s=setup();t.after(s.close);await s.bridge.subscribe(subscription);
 const id=randomUUID();await s.bridge.submit({id,text:'',photos:[syntheticPhoto]});
 const stored=JSON.parse(readFileSync(s.path,'utf8'));const body=join(`${s.path}.photos`,stored.messages[0].photoFiles[0]);
 mkdirSync(`${s.path}.tmp`);
 await assert.rejects(s.bridge.reply({utterance_id:id,text:'Reply'}));
 assert.ok(statSync(body).isFile());assert.equal(s.bridge.history()[0].reply,undefined);
 rmSync(`${s.path}.tmp`,{recursive:true});s.bridge.close();
 const orphan=join(`${s.path}.photos`,'a'.repeat(64));writeFileSync(orphan,'unused',{mode:0o600});
 stored.messages[0].photos=[syntheticPhoto];delete stored.messages[0].photoFiles;
 writeFileSync(s.path,JSON.stringify(stored));
 const restored=new Bridge(s.path,s.sender,s.hosts);t.after(()=>restored.close());
 assert.throws(()=>statSync(orphan),{code:'ENOENT'});
 assert.equal(JSON.parse(readFileSync(s.path,'utf8')).messages[0].photos,undefined);
 assert.deepEqual(restored.pendingResult().content[2],{type:'image',...syntheticPhoto});
});

for (const failure of ['missing', 'digest mismatch', 'stricter image limit']) test(`unavailable photo (${failure}) expires without stopping ordinary conversations`, async t => {
 const s=setup();t.after(s.close);await s.bridge.subscribe(subscription);
 const id=randomUUID();await s.bridge.submit({id,text:'Keep conversation',photos:[syntheticPhoto]});s.bridge.close();
 const stored=JSON.parse(readFileSync(s.path,'utf8'));
 const digest=stored.messages[0].photoFiles[0], body=join(`${s.path}.photos`,digest);
 if(failure==='missing')rmSync(body);
 else if(failure==='digest mismatch')writeFileSync(body,Buffer.from(photoFixture(2048).data,'base64'));
 else {
  // A body stored under a looser per-image policy exceeds today's bound.
  const larger=photoFixture(513*1024), largerDigest=photoDigest(larger);
  writeFileSync(join(`${s.path}.photos`,largerDigest),Buffer.from(larger.data,'base64'));
  stored.messages[0].photoFiles=[largerDigest];stored.messages[0].photoDigests=[largerDigest];
  writeFileSync(s.path,JSON.stringify(stored));
 }
 const restored=new Bridge(s.path,s.sender,s.hosts);t.after(()=>restored.close());
 const history=restored.history();assert.equal(history[0].text,'Keep conversation');assert.equal(history[0].photosExpired,true);assert.equal(history[0].photoCount,1);
 const result=restored.pendingResult();assert.equal(result.content.some(c=>c.type==='image'),false);assert.equal(result.structuredContent.utterances[0].photos_expired,true);
 assert.deepEqual(JSON.parse(readFileSync(s.path,'utf8')).messages[0].photoDigests,stored.messages[0].photoDigests);
 await restored.submit({id:randomUUID(),text:'Text still works'});
 await restored.reply({utterance_id:id,text:'Please resend'});
 assert.equal(restored.history()[0].reply,'Please resend');
});
