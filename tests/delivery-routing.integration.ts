import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bridge} from '../server/bridge.ts';
import {DeliveryRouting} from '../server/delivery-routing.ts';
import {G2DeliveryAvailability} from '../server/g2-availability.ts';
import {bridgeServer} from '../server/http.ts';
import {deviceServer} from '../server/device.ts';
import {NotificationInbox} from '../server/notifications.ts';
import {WebhookSender} from '../server/webhook.ts';
import {GlassesAvailability, type DeliveryAvailability} from '../src/g2-availability.ts';
import {CHAT_HANDOFF_MEDIA_TYPE} from '../src/relay-connection.ts';
import {message} from '../src/i18n.ts';

const owner = 'a'.repeat(64), otherOwner = 'b'.repeat(64), runtime = 'c'.repeat(64);
const deviceHeaders = {'X-G2-Location-Owner': owner, 'X-G2-Paired-Runtime': runtime};
const scope = {session_id: 'personal-g2'};

async function fixture(t: TestContext, allowedOwner = owner, holdMs = 1500) {
  const directory = mkdtempSync(join(tmpdir(), 'dot-delivery-'));
  const path = join(directory, 'chat-handoffs.json');
  let now = Date.now(), currentRuntime = runtime;
  const tokens = {mcp: 'm'.repeat(43), device: 'd'.repeat(43), notification: 'n'.repeat(43)};
  const hosts = ['callback.example.test'];
  const events: {name: string; data: {notification_id?: string; recipient_receipt?: string}}[] = [];
  const sender = new WebhookSender(async (_url, body) => {
    const event = JSON.parse(body);
    if (event.type === 'verification') return {status: 200, body: JSON.stringify({challenge: event.challenge})};
    events.push(event);
    return {status: 202, body: '{}'};
  });
  const mac = new G2DeliveryAvailability((subject, id) => subject === allowedOwner && id === currentRuntime, () => performance.now(), 1200, holdMs, 50);
  const routing = new DeliveryRouting(path, mac, subject => subject === allowedOwner);
  const bridge = new Bridge(join(directory, 'bridge.json'), sender, hosts, undefined, {now: () => now, routing});
  const notifications = new NotificationInbox(join(directory, 'notifications.json'), sender, hosts, () => now, routing);
  const server = bridgeServer(bridge, tokens, notifications, undefined, undefined, undefined, undefined, undefined, undefined, mac);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;
  t.after(async () => {
    mac.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, {recursive: true, force: true});
  });
  async function http(path: string, key: keyof typeof tokens, body?: unknown, headers: Record<string,string> = {}, signal?: AbortSignal) {
    const response = await fetch(base + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {Authorization: 'Bearer ' + tokens[key], 'Content-Type': 'application/json', ...headers}, signal,
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, data: await response.json()};
  }
  async function rpc(method: string, params: object = {}) {
    return (await http('/mcp', 'mcp', {jsonrpc: '2.0', id: 1, method, params})).data;
  }
  const tool = (name: string, args: object = {}) => rpc('tools/call', {name, arguments: args});
  async function result(name: string, args: object = {}) {
    const response = await tool(name, args);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result.structuredContent;
  }
  const delivery = (name: string) => ({mode: 'webhook', url: 'https://callback.example.test/' + name,
    secret: 'whsec_' + randomBytes(32).toString('base64')});
  const subscribe = async (name: string, callback = name) => {
    const response = await rpc('events/subscribe', {name, arguments: scope, delivery: delivery(callback)});
    assert.ok(response.result, JSON.stringify(response.error));
  };
  await subscribe('utterance.created');
  await subscribe('notification.created');
  const fetchUpdates = (headers: Record<string,string> = deviceHeaders, signal?: AbortSignal) => http('/api/updates', 'device', undefined, headers, signal);
  async function nextChallenge(headers = deviceHeaders) {
    const signal = AbortSignal.timeout(6000);
    let snapshot = (await fetchUpdates(headers, signal)).data;
    while (!snapshot.availabilityChallenge) {
      snapshot = (await fetchUpdates({...headers, 'X-G2-Revision': snapshot.revision}, signal)).data;
    }
    return snapshot.availabilityChallenge as {id: string};
  }
  const history = async (subject = owner) => (await http('/api/messages', 'device', undefined, {'X-G2-Location-Owner': subject})).data;
  async function decide(send: () => Promise<any>, state: DeliveryAvailability, beforeReply?: () => Promise<void>) {
    await fetchUpdates();
    let notify!: () => void;
    const ready = new Promise<void>(resolve => {notify = resolve;});
    const unsubscribe = mac.changes.subscribe(notify);
    const decision = send();
    try {
      await Promise.race([ready, decision.then(() => {throw Error('Decision finished before checking the G2');})]);
      const challenge = (await fetchUpdates()).data.availabilityChallenge;
      assert.ok(challenge);
      if (beforeReply) await beforeReply();
      assert.equal((await http('/api/g2-availability', 'device', {...challenge, state}, deviceHeaders)).status, 200);
      return await decision;
    } finally { unsubscribe(); }
  }
  async function question(text = 'Which entrance for the fictional train?') {
    const id = randomUUID();
    assert.equal((await http('/api/utterances', 'device', {id, text}, deviceHeaders)).status, 200);
    return {id, text};
  }
  async function notification() {
    const id = randomUUID();
    const n = {id, source_app: 'Fixture Schedule', title: 'Fixture departure', body: 'Use the south entrance.',
      observed_at: new Date(now).toISOString(), source_verification: 'accessibility'};
    assert.equal((await http('/api/notifications', 'notification', n)).status, 200);
    const signedEvent = events.find(e => e.data.notification_id === id);
    assert.ok(signedEvent?.data.recipient_receipt);
    return {notification_id: id, recipient_receipt: signedEvent.data.recipient_receipt};
  }
  return {path, directory, base, deviceToken:tokens.device, mac, routing, bridge, events, http, rpc, tool, result, subscribe, fetchUpdates,
    history, decide, question, notification, nextChallenge, advance(ms: number) {now += ms;}, replaceRuntime() {currentRuntime = 'e'.repeat(64);}};
}

test('the published Even companion finishes a handed-off question without announcing the answer on G2', async t => {
  const oldOwner = createHash('sha256').update('d'.repeat(43)).digest('hex');
  const f = await fixture(t, oldOwner);
  const host = 'mac.example.test', origin = 'https://' + host;
  const gateway = deviceServer({token:f.deviceToken, origin, directory:f.directory, bridgeURL:f.base, transcribe:async () => ''});
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const address = gateway.address(); assert(address && typeof address === 'object');
  const port = address.port;
  t.after(() => {gateway.closeAllConnections(); gateway.close();});
  function device(path: string, body?: unknown, accept = '*/*') {
    return new Promise<any>((resolve, reject) => {
      const req = request({host:'127.0.0.1', port, path, method: body ? 'POST' : 'GET',
        headers:{Host:host, Origin:origin, Authorization:'Bearer ' + f.deviceToken, 'Content-Type':'application/json',
          Accept:accept, 'Accept-Language':'ja-JP, en;q=0.8'}}, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(Buffer.concat(chunks).toString())) : reject(Error(String(res.statusCode))));
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const question = {id:randomUUID(), text:'Where is the fictional sculpture?'};
  assert.equal((await device('/api/utterances', question)).reply, undefined);
  const answer = 'Beside the north entrance.';
  const handoff = await f.result('reply_to_g2', {utterance_id:question.id, text:answer});
  assert.equal(handoff.destination, 'owner_chat');
  const beforeClaim = (await device('/api/updates')).messages[0];
  assert.notEqual(beforeClaim.status, 'chat_handoff');
  assert.equal(beforeClaim.reply, undefined);
  const [pending] = (await f.result('get_pending_utterances')).utterances;
  assert.equal(pending.utterance_id, question.id); assert.equal(pending.chat_handoff_pending, true);
  assert.equal(pending.receipt, undefined);
  const renewed = await f.result('reply_to_g2', {utterance_id:question.id, text:answer});
  assert.equal(renewed.receipt, handoff.receipt);
  assert.equal((await f.result('claim_owner_chat_delivery', {receipt:renewed.receipt})).text, answer);
  assert.deepEqual((await f.result('get_pending_utterances')).utterances, []);
  const hint = message('even.continue_in_dot_chat', 'ja');
  const [oldRow] = await device('/api/messages');
  assert.equal(oldRow.id, question.id); assert.equal(oldRow.text, question.text);
  assert.equal(oldRow.reply, hint); assert.equal(oldRow.location_sharing_id, 'dotlink:owner-chat');
  assert.equal(oldRow.location_expires_at, undefined); assert.equal(oldRow.photosExpired, undefined);
  assert.deepEqual((await device('/api/updates')).messages, [oldRow]);
  assert.deepEqual(await device('/api/utterances', question), oldRow);
  const canonical = (await f.history(oldOwner))[0];
  assert.equal(canonical.status, 'chat_handoff'); assert.equal(canonical.reply, undefined);
  assert.equal(canonical.location_sharing_id, undefined);
  const accept = 'application/json, ' + CHAT_HANDOFF_MEDIA_TYPE;
  assert.deepEqual(await device('/api/messages', undefined, accept), [canonical]);
  assert.deepEqual((await device('/api/updates', undefined, accept)).messages, [canonical]);
  assert.deepEqual(await device('/api/utterances', question, accept), canonical);
  assert.deepEqual(await f.history(otherOwner), []);
  assert.equal((await f.result('claim_owner_chat_delivery', {receipt:handoff.receipt})).action, 'do_not_resend');
});

test('one independent Dot decision uses G2 when available and the existing owner chat otherwise', async t => {
  const f = await fixture(t);
  const text = 'The fictional service departs at noon.';
  const first = {message_id: randomUUID(), text}, second = {...first, message_id: randomUUID()};
  const g2 = await f.decide(() => f.result('send_message_to_g2', first), 'available');
  assert.equal(g2.stored_for_g2, true);
  assert.equal(g2.physical_display_confirmed, false);
  const chat = await f.decide(() => f.result('send_message_to_g2', second), 'unavailable');
  assert.equal(chat.destination, 'owner_chat');
  assert.equal(chat.stored_for_g2, false);
  const claims = await Promise.all([1,2].map(() => f.result('claim_owner_chat_delivery', {receipt: chat.receipt})));
  assert.deepEqual(claims.map(c => c.action).sort(), ['do_not_resend', 'send_once_in_existing_owner_chat']);
  assert.equal(claims.find(c => c.text)?.text, text);
  assert.ok(claims.every(c => c.native_delivery_confirmed === false));
  assert.equal((await f.result('send_message_to_g2', second)).action, 'do_not_resend');
  assert.equal((await f.result('send_message_to_g2', first)).stored_for_g2, true);
  assert.deepEqual((await f.history()).map((row: any) => row.id), ['dot:' + first.message_id]);
  assert.deepEqual(await f.history(otherOwner), []);
  assert.ok(!readFileSync(f.path, 'utf8').includes(text));
  assert.equal(new DeliveryRouting(f.path, f.mac, () => true).take({receipt: chat.receipt}).action, 'do_not_resend');
  const discovery = await f.rpc('tools/list');
  const guide = discovery.result.tools.find((tool: any) => tool.name === 'send_message_to_g2');
  assert.match(guide.description, /questions in official chat stay in that chat/);
});

test('an answer follows its original G2 question at send time, including removal and a distinct follow-up', async t => {
  const f = await fixture(t);
  const first = await f.question();
  const text = 'Use the south entrance.';
  const paired = await f.decide(() => f.result('reply_to_g2', {utterance_id: first.id, text}), 'available');
  assert.equal(paired.delivered_to_bridge, true);
  const sameFirst = {utterance_id: first.id, message_id: randomUUID(), text};
  assert.equal((await f.result('send_message_to_g2', sameFirst)).stored_for_g2, true);
  const second = await f.question();
  assert.equal((await f.result('get_pending_utterances')).utterances[0].utterance_id, second.id);
  const send = {utterance_id: second.id, message_id: randomUUID(), text};
  const chat = await f.decide(() => f.result('send_message_to_g2', send), 'unavailable');
  const retry = await f.result('reply_to_g2', {utterance_id: second.id, text});
  assert.equal(retry.receipt, chat.receipt);
  const claim = await f.result('claim_owner_chat_delivery', {receipt: chat.receipt});
  assert.equal(claim.original_question, second.text);
  assert.equal(claim.utterance_id, second.id);
  assert.equal((await f.result('get_pending_utterances')).utterances.length, 0);
  const more = {...send, message_id: randomUUID(), text: 'The meeting time is noon.'};
  const followup = await f.decide(() => f.result('send_message_to_g2', more), 'unknown');
  assert.equal((await f.result('claim_owner_chat_delivery', {receipt: followup.receipt})).utterance_id, second.id);
  const rows = await f.history();
  assert.equal(rows.find((row: any) => row.id === first.id).reply, text);
  const transferred = rows.find((row: any) => row.id === second.id);
  assert.equal(transferred.status, 'chat_handoff');
  assert.equal(transferred.reply, undefined);
  assert.equal(rows.length, 2);
  assert.equal((await f.http('/api/utterances', 'device', first, {'X-G2-Location-Owner': otherOwner})).status, 400);
});

test('a typed question survives loss of the phone and a reopened companion selects the fresh case position', {timeout: 12_000}, async t => {
  for (const inCase of [false, true]) {
    const f = await fixture(t, owner, 5000);
    const original = await f.question();
    const args = {utterance_id: original.id, text: 'A reply for the original question.'};
    const pending = f.result('reply_to_g2', args);
    const retry = f.result('reply_to_g2', args);
    // Initially no companion is connected. Its first poll recovers the check,
    // but the glasses still have no reading during the network transition.
    const interrupted = await f.nextChallenge();
    assert.equal((await f.http('/api/g2-availability','device',{...interrupted,state:'unknown'},deviceHeaders)).status, 200);
    assert.equal((await f.history())[0].reply, undefined);
    f.replaceRuntime();
    const headers = {...deviceHeaders, 'X-G2-Paired-Runtime':'e'.repeat(64)};
    const offer = await f.nextChallenge(headers);
    assert.notEqual(offer.id, interrupted.id);
    assert.equal((await f.http('/api/g2-availability','device',{...interrupted,state:'available'},deviceHeaders)).status, 409);
    const reopened = new GlassesAvailability();
    await reopened.answer(offer, () => reopened.read({callEvenApp:async () => ({model:'g2',
      status:{connectType:'connected', isInCase:inCase, isWearing:false, isCharging:inCase}})}),
      () => true, async (id, state) => {
        assert.equal(reopened.reportedCasePosition, inCase ? 'inside' : 'outside');
        assert.equal((await f.http('/api/g2-availability','device',{id,state},headers)).status, 200);
      });
    const [answer, repeated] = await Promise.all([pending, retry]);
    assert.deepEqual(repeated, answer);
    if (inCase) {
      assert.equal(answer.destination, 'owner_chat');
      assert.equal(answer.stored_for_g2, false);
      assert.equal((await f.result('claim_owner_chat_delivery', {receipt:answer.receipt})).action, 'send_once_in_existing_owner_chat');
      assert.equal((await f.history())[0].reply, undefined);
    } else {
      assert.equal(answer.delivered_to_bridge, true);
      assert.deepEqual((await f.history()).map((row: any) => [row.id,row.reply]), [[original.id,args.text]]);
    }
  }
});

test('expiry hands the answer to the original chat once, even if G2 reconnects and the Dot retries', async t => {
  const f = await fixture(t);
  const q = await f.question(), args = {utterance_id:q.id, text:'A single reply.'};
  const pending = f.result('reply_to_g2', args);
  const offer = await f.nextChallenge();
  const answer = await pending;
  assert.equal(answer.destination, 'owner_chat');
  assert.equal(answer.stored_for_g2, false);
  assert.equal((await f.http('/api/g2-availability','device',{...offer,state:'available'},deviceHeaders)).status, 409);
  const firstClaim = await f.result('claim_owner_chat_delivery', {receipt: answer.receipt});
  assert.equal(firstClaim.action, 'send_once_in_existing_owner_chat');
  assert.equal((await f.result('reply_to_g2', args)).action, 'do_not_resend');
  assert.equal((await f.result('claim_owner_chat_delivery', {receipt: answer.receipt})).action, 'do_not_resend');
  assert.deepEqual((await f.history()).map((row: any) => [row.id,row.status,row.reply]), [[q.id,'chat_handoff',undefined]]);
});

test('the same phone can recover on another network without a runtime restart or a gesture', {timeout: 8000}, async t => {
  const f = await fixture(t, owner, 5000);
  const q = await f.question();
  const send = f.result('reply_to_g2', {utterance_id:q.id, text:'Recovered reply.'});
  const first = await f.nextChallenge();
  assert.equal((await f.http('/api/g2-availability','device',{...first,state:'unknown'},deviceHeaders)).status, 200);
  const next = await f.nextChallenge();
  assert.notEqual(first.id, next.id);
  assert.equal((await f.http('/api/g2-availability','device',{...next,state:'available'},deviceHeaders)).status, 200);
  assert.equal((await send).delivered_to_bridge, true);
  assert.deepEqual((await f.history()).map((row: any) => row.reply), ['Recovered reply.']);
});

test('a signed notification selects one recipient, respects silence/defer and records no receipt on an ordinary history fetch', async t => {
  const f = await fixture(t);
  const source = await f.notification(), quiet = await f.notification(), delayed = await f.notification();
  const read = (params: object) => f.result('get_pending_notifications', params);
  const decide = (input: object, disposition: string) => f.result('set_notification_disposition', {...input, disposition});
  const noReceipt = await read({});
  assert.deepEqual(noReceipt.notifications, []);
  assert.match(noReceipt.connection_guidance, /update the existing Dot Link plugin tools/);
  assert.deepEqual((await read({...source, recipient_receipt: randomUUID()})).notifications, []);
  const status = async (n: typeof source) => (await f.http('/api/notifications/status', 'notification', {ids: [n.notification_id]})).data.notifications[0];
  assert.equal((await status(source)).dot_read_at, undefined);
  assert.deepEqual((await read(source)).notifications.map((row: any) => row.notification_id), [source.notification_id]);
  await decide(quiet, 'silent');
  assert.equal((await f.tool('announce_notification_to_g2', {...quiet, text: 'Fixture.'})).error.data.reason, 'notification_silent');
  const race = await f.decide(() => f.tool('announce_notification_to_g2', {...delayed, text: 'Earlier decision.'}),
    'unavailable', async () => {await decide(delayed, 'later');});
  assert.equal(race.error.data.reason, 'notification_changed');
  assert.deepEqual((await read(delayed)).notifications, []);
  assert.equal((await read({...delayed, include_deferred: true})).notifications[0].disposition, 'later');
  const announce = {...source, text: 'The fictional service leaves soon.'};
  assert.equal((await f.decide(() => f.result('announce_notification_to_g2', announce), 'available')).stored_for_g2, true);
  assert.equal((await f.history())[0].id, 'notification:' + source.notification_id);
  assert.ok(!(await status(source)).client_response_at);
  const offered = (await f.fetchUpdates()).data.notificationReceipt;
  assert.ok(offered);
  await f.fetchUpdates({...deviceHeaders, 'X-G2-Notification-Receipt': randomUUID()});
  await f.fetchUpdates({...deviceHeaders, 'X-G2-Location-Owner': otherOwner, 'X-G2-Notification-Receipt': offered});
  assert.equal((await status(source)).client_response_at, undefined);
  await f.fetchUpdates({...deviceHeaders, 'X-G2-Notification-Receipt': offered});
  assert.ok((await status(source)).client_response_at);
  const later = await f.decide(() => f.result('announce_notification_to_g2', {...delayed, text: 'Now relevant.'}), 'unavailable');
  assert.equal((await f.result('claim_owner_chat_delivery', {receipt: later.receipt})).text, 'Now relevant.');
  assert.equal((await status(delayed)).status, 'chat_handoff');
  assert.equal((await status(delayed)).client_response_at, undefined);
  assert.equal((await f.history()).length, 1);
});

test('a verified callback can resume its unanswered question and deferred notification after its leases lapse', async t => {
  const f = await fixture(t);
  const question = await f.question(), notification = await f.notification();
  const deferred = {...notification, include_deferred: true};
  await f.result('set_notification_disposition', {...notification, disposition: 'later'});
  f.advance(24 * 60 * 60 * 1000 + 1);
  assert.deepEqual((await f.result('get_pending_utterances')).utterances, []);
  assert.deepEqual((await f.result('get_pending_notifications', deferred)).notifications, []);

  await f.subscribe('utterance.created');
  await f.subscribe('notification.created');
  assert.deepEqual((await f.result('get_pending_utterances')).utterances.map((item: any) => item.utterance_id), [question.id]);
  assert.equal((await f.result('get_pending_notifications', deferred)).notifications[0].notification_id, notification.notification_id);
  const reply = await f.result('reply_to_g2', {utterance_id: question.id, text: 'The south entrance.'});
  assert.equal((await f.result('claim_owner_chat_delivery', {receipt: reply.receipt})).utterance_id, question.id);
  const announcement = await f.result('announce_notification_to_g2', {...notification, text: 'The fictional service is ready.'});
  assert.equal((await f.result('claim_owner_chat_delivery', {receipt: announcement.receipt})).text, 'The fictional service is ready.');
});

test('a different verified callback cannot resume a lapsed recipient, even if the former callback later returns', async t => {
  const f = await fixture(t);
  const question = await f.question(), notification = await f.notification();
  for (const suffix of ['/replacement', '']) {
    f.advance(24 * 60 * 60 * 1000 + 1);
    await f.subscribe('utterance.created', 'utterance.created' + suffix);
    await f.subscribe('notification.created', 'notification.created' + suffix);
    assert.deepEqual((await f.result('get_pending_utterances')).utterances, []);
    assert.deepEqual((await f.result('get_pending_notifications', notification)).notifications, []);
    assert.equal((await f.tool('reply_to_g2', {utterance_id: question.id, text: 'The south entrance.'})).error.data.reason, 'delivery_access_changed');
  }
});

test('lease replacement and stopped sharing invalidate unclaimed grants without writing to either G2 history', async t => {
  const f = await fixture(t);
  const epoch = randomUUID(), controlId = randomUUID();
  const control = (enabled: boolean) => writeFileSync(join(f.directory, 'notification-sharing.json'),
    JSON.stringify({version: 1, id: controlId, epoch, updatedAt: Date.now(), enabled}));
  const q = await f.question(), source = await f.notification();
  const reply = await f.result('reply_to_g2', {utterance_id: q.id, text: 'A fictional answer.'});
  const announcement = await f.result('announce_notification_to_g2', {...source, text: 'A fictional announcement.'});
  control(false);
  assert.equal((await f.tool('claim_owner_chat_delivery', {receipt: announcement.receipt})).error.data.reason, 'delivery_access_changed');
  assert.deepEqual((await f.result('get_pending_notifications', source)).notifications, []);
  await f.rpc('events/unsubscribe', {name: 'utterance.created', arguments: scope, delivery: {mode: 'webhook', url: 'https://callback.example.test/utterance.created'}});
  await f.subscribe('utterance.created');
  assert.equal((await f.tool('claim_owner_chat_delivery', {receipt: reply.receipt})).error.data.reason, 'delivery_access_changed');
  assert.equal((await f.tool('reply_to_g2', {utterance_id: q.id, text: 'A fictional answer.'})).error.data.reason, 'delivery_access_changed');
  assert.deepEqual((await f.result('get_pending_utterances')).utterances, []);
  assert.ok((await f.history()).every((row: any) => row.reply === undefined));
});

test('an older companion times out and a restarted Mac rechecks the source before releasing a handoff', async t => {
  const f = await fixture(t);
  await f.fetchUpdates();
  const message = {message_id: randomUUID(), text: 'Fixture route after a timeout.'};
  const chat = await f.result('send_message_to_g2', message);
  assert.equal(chat.destination, 'owner_chat');
  assert.equal(chat.native_delivery_confirmed, false);
  const restarted = new DeliveryRouting(f.path, f.mac, () => true);
  assert.throws(() => restarted.take({receipt: chat.receipt}), /original guarded decision/);
  const restored = new Bridge(join(f.directory, 'bridge.json'), new WebhookSender(async () => {throw Error('Unexpected webhook');}),
    [], undefined, {routing: restarted});
  t.after(() => restored.close());
  const retry = await restored.sendMessage(message);
  assert.ok('receipt' in retry);
  assert.equal(retry.receipt, chat.receipt);
  const granted = restarted.take({receipt: retry.receipt});
  assert.ok('text' in granted);
  assert.equal(granted.text, message.text);
  assert.deepEqual(await f.history(), []);
  const changed = await f.tool('send_message_to_g2', {...message, text: 'Different.'});
  assert.equal(changed.error.data.reason, 'delivery_conflict');
});

test('an unreadable handoff ledger preserves existing data and denies new deliveries with an uncertain identity', async t => {
  const f = await fixture(t);
  const q = await f.question();
  writeFileSync(f.path, 'interrupted fixture state');
  const broken = new DeliveryRouting(f.path, f.mac, () => true);
  const restored = new Bridge(join(f.directory, 'bridge.json'), new WebhookSender(async () => {throw Error('Unexpected webhook');}),
    [], undefined, {routing: broken});
  t.after(() => restored.close());
  assert.equal(restored.history(owner)[0].text, q.text);
  await assert.rejects(restored.reply({utterance_id: q.id, text: 'Must not be sent.'}), /original delivery decision/);
  assert.equal(readFileSync(f.path, 'utf8'), 'interrupted fixture state');
});

test('pre-update saved notification history stays intact and a new ticket cannot reveal unbound entries as a batch', async t => {
  const f = await fixture(t);
  const first = await f.notification();
  const file = join(f.directory, 'notifications.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  delete saved.notifications[0].audience;
  saved.notifications[0].body = 'Pre-update fixture content';
  const bytes = JSON.stringify(saved);
  writeFileSync(file, bytes);
  const migrated = new NotificationInbox(file, new WebhookSender(async () => {throw Error('Unexpected webhook');}),
    ['callback.example.test'], Date.now, f.routing);
  t.after(() => migrated.close());
  assert.deepEqual(migrated.pending({recipient_receipt: first.recipient_receipt}).notifications, []);
  assert.deepEqual(migrated.pending({...first, recipient_receipt: randomUUID()}).notifications, []);
  assert.equal(migrated.pending({notification_id: first.notification_id}).notifications[0].body, saved.notifications[0].body);
  const after = JSON.parse(readFileSync(file, 'utf8')).notifications[0];
  assert.equal(after.body, saved.notifications[0].body);
  assert.equal(after.status, saved.notifications[0].status);
  assert.equal(after.audience, undefined);
  assert.equal(after.client_response_at, undefined);
});

test('a new silent or deferred choice can withdraw a notification until its native send is claimed', async t => {
  const f = await fixture(t);
  const source = await f.notification();
  const announce = (text: string) => f.result('announce_notification_to_g2', {...source, text});
  const pending = await announce('Fictional reminder.');
  await f.result('set_notification_disposition', {...source, disposition: 'later'});
  assert.equal((await f.tool('claim_owner_chat_delivery', {receipt: pending.receipt})).error.data.reason, 'delivery_unknown');
  assert.equal((await f.result('get_pending_notifications', {...source, include_deferred: true})).notifications.length, 1);
  const again = await announce('Updated fictional reminder.');
  await f.result('set_notification_disposition', {...source, disposition: 'silent'});
  assert.equal((await f.tool('claim_owner_chat_delivery', {receipt: again.receipt})).error.data.reason, 'delivery_unknown');
  assert.equal((await f.tool('announce_notification_to_g2', {...source, text: 'Fictional reminder.'})).error.data.reason, 'notification_silent');
  assert.deepEqual(await f.history(), []);
});
