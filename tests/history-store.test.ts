import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { LocationHistoryStore } from '../server/history/store.ts';
import { HISTORY_RETENTION_MS } from '../server/history/replay.ts';
import { Bridge } from '../server/bridge.ts';
import { WebhookSender } from '../server/webhook.ts';
import { historyGeography } from '../server/history/fixtures.ts';
import { geographicEvidence } from '../server/geography/geometry.ts';
const owner = 'a'.repeat(64), other = 'b'.repeat(64);
function setup(t: test.TestContext, beta = true) {
  const directory = mkdtempSync(join(tmpdir(), 'history-store-test-'));
  let clock = Date.parse('2026-11-02T12:00:00Z'), authorized = true;
  const bridge = new Bridge(join(directory, 'bridge.json'), new WebhookSender(async (_url, raw) => { const e = JSON.parse(raw); return {status: 200, body: JSON.stringify(e.type === 'verification' ? {challenge: e.challenge} : {})}; }), ['callback.example.test']);
  const options = {now: () => clock, beta, ownerAuthorized: (id: string) => authorized && id === owner,
    announce: (input: any, guard: () => boolean) => bridge.sendMessage(input, guard)};
  let store = new LocationHistoryStore(join(directory, 'history'), options);
  t.after(() => { store.close(); bridge.close(); rmSync(directory, {recursive: true, force: true}); });
  const control = (action: string, scenario?: string, epoch = store.status(owner).historyEpoch) => store.control({protocol: 1, epoch, action, ...(scenario ? {scenario} : {})}, owner);
  const fix = () => ({latitude: 10.0005, longitude: 10.0005, accuracy: 8, measured_at: new Date(clock).toISOString()});
  const ingest = (sharing = 'session-a', metadata = {protocol: 1, epoch: store.status(owner).historyEpoch, timezone: 'Etc/UTC', utc_offset_minutes: 0}) => store.ingest(fix(), sharing, metadata, owner);
  return {get store() {return store;}, bridge, directory, control, fix, ingest,
    advance(ms: number) {clock += ms;}, revoke() {authorized = false;},
    restart() {store.close(); store = new LocationHistoryStore(join(directory, 'history'), options);}};
}
test('history defaults off, has separate consent, persists only opted-in measurements and survives restart', t => {
  const h = setup(t);
  assert.equal(h.ingest(), false); assert.equal(h.store.read().status, 'unavailable');
  h.control('enable'); h.advance(1000); assert.equal(h.ingest(), true); assert.equal(h.ingest(), false);
  const rows = h.store.read({detail: 'observations'}).entries as any[];
  assert.equal(rows.length, 1); assert.equal(rows[0].source, 'phone_location'); assert.equal(rows[0].timezone, 'Etc/UTC');
  const oldEpoch = h.store.status(owner).historyEpoch;
  h.restart(); assert.notEqual(h.store.status(owner).historyEpoch, oldEpoch); assert.equal(h.store.status(owner).historyCount, 1);
  assert.throws(() => h.control('disable', undefined, oldEpoch));
  assert.equal(statSync(join(h.directory, 'history')).mode & 0o777, 0o700);
  assert.equal(statSync(join(h.directory, 'history/history.sqlite')).mode & 0o777, 0o600);
});
test('disable fences queued enables, uploads and historical replies; delete stops and persists deletion', async t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  const result = h.store.read() as any, epoch = h.store.status(owner).historyEpoch;
  h.control('disable');
  assert.throws(() => h.control('enable', undefined, epoch));
  h.advance(1000); assert.equal(h.ingest('late', {protocol: 1, epoch, timezone: 'Etc/UTC', utc_offset_minutes: 0}), false);
  assert.throws(() => h.store.respond({history_context_id: result.history_context_id, utterance_id: randomUUID(), text: 'stale'}));
  h.control('enable'); assert.equal(h.store.status(owner).historyCount, 1);
  h.control('delete'); h.restart(); assert.equal(h.store.status(owner).historyCount, 0); assert.equal(h.store.status(owner).historyEnabled, false);
});
test('owner revocation deletes history and another device cannot inherit consent', t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  assert.equal(h.store.status(other).historyEpoch, null); assert.equal(h.store.status(other).historyCount, 0);
  assert.throws(() => h.store.control({protocol: 1, epoch: h.store.status(owner).historyEpoch, action: 'enable'}, other));
  h.revoke(); assert.equal(h.store.read().status, 'unavailable'); h.restart(); assert.equal(h.store.read().status, 'unavailable');
});
test('expiry and session boundaries survive restart and cannot be extended by late uploads', t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest('one');
  h.advance(60_000); h.ingest('two');
  const read = h.store.read() as any; assert.equal(read.coverage.gaps[0].reason, 'recording_boundary');
  h.advance(HISTORY_RETENTION_MS); h.restart(); assert.equal(h.store.status(owner).historyCount, 0);
  assert.equal(h.store.read().status, 'empty');
});
test('synthetic cases use durable storage/query while real observations remain isolated', t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  h.control('simulate', 'walk'); const result = h.store.read({detail: 'observations', limit: 50}) as any;
  assert.equal(result.source, 'synthetic_fixture'); assert.ok(result.entries.length > 1);
  assert.ok(result.entries.every((p: any) => p.source === 'synthetic_fixture'));
  h.advance(1000); assert.equal(h.ingest(), false); h.restart(); assert.equal((h.store.read() as any).source, 'synthetic_fixture');
  h.control('finish_simulation'); assert.equal(h.store.status(owner).historyCount, 1); assert.equal((h.store.read() as any).source, 'phone_location');
  h.control('simulate', 'empty'); assert.equal(h.store.read().status, 'empty');
  h.control('simulate', 'revoked'); assert.equal(h.store.read().status, 'unavailable');
  h.control('disable'); assert.equal(h.store.status(owner).historySimulation, null);
});
test('release runtime refuses synthetic control', t => {
  const h = setup(t, false); h.control('enable'); assert.throws(() => h.control('simulate', 'walk'));
});
test('historical answer uses ordinary linked conversation with access recheck', async t => {
  const h = setup(t); h.control('enable'); h.control('simulate', 'walk');
  await h.bridge.subscribe({name: 'utterance.created', arguments: {session_id: 'personal-g2'}, delivery: {mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64')}});
  const question = await h.bridge.submit({id: randomUUID(), text: 'Which fictional road?'});
  const read = h.store.read() as any;
  const answer = {history_context_id: read.history_context_id, utterance_id: question.id, text: 'The fictional east road.'};
  await h.store.respond(answer); await h.store.respond(answer);
  assert.equal(h.bridge.history().find(x => x.id === question.id)?.reply, answer.text);
  assert.equal(h.bridge.outboundHistory().length, 0);
  h.control('finish_simulation'); assert.throws(() => h.store.respond(answer));
});
test('existing geographic evidence is attached without acquiring another map', t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  h.store.attachGeography(h.fix(), geographicEvidence(h.fix(), historyGeography), owner);
  h.restart(); const read = h.store.read({detail: 'observations'}) as any;
  assert.equal(read.entries[0].geography.status, 'available');
  assert.ok(read.entries[0].geography.lines.length > 0);
});

test('a queued historical reply rechecks deletion before the normal reply commit', async t => {
  const h = setup(t); h.control('enable'); h.control('simulate', 'walk');
  await h.bridge.subscribe({name: 'utterance.created', arguments: {session_id: 'personal-g2'}, delivery: {mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64')}});
  const question = await h.bridge.submit({id: randomUUID(), text: 'Which fictional road?'});
  const read = h.store.read() as any;
  const pending = h.store.respond({history_context_id: read.history_context_id, utterance_id: question.id, text: 'Must not arrive.'});
  h.control('delete');
  await assert.rejects(pending, /Historical access changed/);
  assert.equal(h.bridge.history().find(x => x.id === question.id)?.reply, undefined);
  assert.equal(h.store.status(owner).historyCount, 0);
});
