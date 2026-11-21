import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../server/bridge.ts';
import { NotificationInbox } from '../server/notifications.ts';
import { rpc } from '../server/http.ts';
import { MAX_CALLBACK_VERIFICATIONS, WebhookSender } from '../server/webhook.ts';

const secret = 'whsec_' + randomBytes(32).toString('base64');
const voice = (url = 'https://callback.example.test/events') => ({ name: 'utterance.created', arguments: { session_id: 'personal-g2' },
  delivery: { mode: 'webhook', url, secret }, cursor: null });
const notification = (url = 'https://callback.example.test/notifications') => ({ ...voice(url), name: 'notification.created' });

/** A callback whose verification answers only when the test releases it. */
function harness(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'g2-subscription-verify-'));
  const held: (() => void)[] = [];
  let hold = false, verifications = 0;
  const events: any[] = [];
  const sender = new WebhookSender(async (_url, body) => {
    const payload = JSON.parse(body);
    if (payload.type !== 'verification') { events.push(payload); return { status: 202, body: '{}' }; }
    verifications++;
    const answer = { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    if (!hold) return answer;
    return new Promise(resolve => held.push(() => resolve(answer)));
  });
  const hosts = ['callback.example.test'];
  const bridge = new Bridge(join(dir, 'voice.json'), sender, hosts);
  const inbox = new NotificationInbox(join(dir, 'notifications.json'), sender, hosts);
  t.after(() => { for (const release of held.splice(0)) release(); bridge.close(); inbox.close(); rmSync(dir, { recursive: true, force: true }); });
  return { bridge, inbox, events, held, hold: (value: boolean) => { hold = value; }, verifications: () => verifications,
    releaseAll: () => { for (const release of held.splice(0)) release(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a slow callback verification does not delay utterances, replies or messages', async t => {
  const s = harness(t);
  await s.bridge.subscribe(voice());
  s.hold(true);
  const renewal = s.bridge.subscribe(voice());
  await settle();
  assert.equal(s.held.length, 1, 'renewal verification is in flight');
  const id = randomUUID();
  assert.equal((await s.bridge.submit({ id, text: 'hello' })).status, 'accepted');
  assert.deepEqual(await s.bridge.reply({ utterance_id: id, text: 'reply' }), { utterance_id: id, delivered_to_bridge: true });
  assert.equal((await s.bridge.sendMessage({ message_id: randomUUID(), text: 'proactive' })).stored_for_g2, true);
  s.releaseAll();
  assert.match((await renewal).id, /^sub_/);
});

test('notification intake and announcements proceed while its subscription is verifying', async t => {
  const s = harness(t);
  await s.inbox.subscribe(notification());
  s.hold(true);
  const renewal = s.inbox.subscribe(notification());
  await settle();
  const item = { id: randomUUID(), source_app: 'Dot Notification Lab', title: 'DOT-LAB-0A1B2C3D', body: 'b',
    observed_at: new Date().toISOString(), source_verification: 'synthetic-test-marker' };
  assert.equal((await s.inbox.submit(item)).status, 'accepted');
  assert.equal((await s.inbox.announce({ notification_id: item.id, text: 'announced' })).stored_for_g2, true);
  s.releaseAll(); await renewal;
});

test('identical concurrent renewals share one verification', async t => {
  const s = harness(t);
  s.hold(true);
  const renewals = [s.bridge.subscribe(voice()), s.bridge.subscribe(voice()), s.bridge.subscribe(voice())];
  await settle();
  assert.equal(s.verifications(), 1);
  s.releaseAll();
  const results = await Promise.all(renewals);
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal(s.bridge.status().subscribed, true);
});

test('verifications beyond the process limit are rejected before any network work', async t => {
  const s = harness(t);
  s.hold(true);
  const running = Array.from({ length: MAX_CALLBACK_VERIFICATIONS }, (_, i) =>
    (i % 2 ? s.inbox : s.bridge).subscribe((i % 2 ? notification : voice)(`https://callback.example.test/${i}`)).catch(error => error));
  await settle();
  assert.equal(s.verifications(), MAX_CALLBACK_VERIFICATIONS);
  const response = await rpc(s.bridge, { jsonrpc: '2.0', id: 1, method: 'events/subscribe', params: voice('https://callback.example.test/extra') }) as any;
  assert.equal(response.error.data.reason, 'verification_busy');
  assert.equal(s.verifications(), MAX_CALLBACK_VERIFICATIONS, 'the rejected request sent nothing');
  s.releaseAll(); await Promise.all(running);
  s.hold(false);
  assert.match((await s.bridge.subscribe(voice('https://callback.example.test/0'))).id, /^sub_/, 'capacity returns after completion');
});

test('an unsubscribe during verification is not undone by the late verification result', async t => {
  for (const feature of ['bridge', 'inbox'] as const) {
    const s = harness(t);
    const target = feature === 'bridge' ? s.bridge : s.inbox;
    const request = feature === 'bridge' ? voice() : notification();
    const unsubscribe = () => target.unsubscribe({ name: request.name, arguments: request.arguments, delivery: { mode: 'webhook', url: request.delivery.url } });
    // First subscription and renewal: a late verification never restores a removed callback.
    for (const phase of ['first', 'renewal']) {
      if (phase === 'renewal') { s.hold(false); await target.subscribe(request); }
      s.hold(true);
      const pending = target.subscribe(request);
      await settle();
      await unsubscribe();
      s.releaseAll();
      await assert.rejects(pending, (error: any) => error.reason === 'subscription_changed', `${feature} ${phase}`);
    }
    const status = target.status() as any;
    assert.equal(feature === 'bridge' ? status.subscribed : status.notificationSubscribed, false, `${feature} stays unsubscribed`);
  }
});

test('an utterance sent during the first subscription still waits for it, as before', async t => {
  const s = harness(t);
  s.hold(true);
  const subscribing = s.bridge.subscribe(voice());
  await settle();
  const submitted = s.bridge.submit({ id: randomUUID(), text: 'first words' });
  await settle();
  s.releaseAll(); await subscribing;
  assert.equal((await submitted).status, 'accepted');
  assert.equal(s.events.length, 1);
});

test('removing an expired or different callback never cancels an unrelated pending subscription', async t => {
  let now = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'g2-subscription-unrelated-'));
  const held: (() => void)[] = [];
  let hold = false;
  const sender = new WebhookSender(async (_url, body) => {
    const payload = JSON.parse(body);
    const answer = { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    return hold && payload.type === 'verification' ? new Promise(resolve => held.push(() => resolve(answer))) : answer;
  });
  const hosts = ['callback.example.test'];
  const bridge = new Bridge(join(dir, 'voice.json'), sender, hosts, undefined, { now: () => now });
  const inbox = new NotificationInbox(join(dir, 'notifications.json'), sender, hosts, () => now);
  t.after(() => { for (const release of held.splice(0)) release(); bridge.close(); inbox.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const [target, make, subscribed] of [
    [bridge, voice, () => bridge.status().subscribed],
    [inbox, notification, () => inbox.status().notificationSubscribed],
  ] as const) {
    const a = make('https://callback.example.test/a'), b = make('https://callback.example.test/b');
    hold = false;
    await target.subscribe({ ...a, ttlMs: 1000 });
    now += 2000; // A is stored but expired, so B passes the conflict check.
    hold = true;
    const pendingB = target.subscribe(b);
    await settle();
    await target.unsubscribe({ name: a.name, arguments: a.arguments, delivery: { mode: 'webhook', url: a.delivery.url } });
    for (const release of held.splice(0)) release();
    assert.match((await pendingB).id, /^sub_/);
    assert.equal(subscribed(), true, 'B stays active');
  }
});
