import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { LocationHistoryStore } from '../server/history/store.ts';
import { HISTORY_RETENTION_MS } from '../server/history/replay.ts';
import { Bridge } from '../server/bridge.ts';
import { WebhookSender } from '../server/webhook.ts';
import { historyGeography, historyFixture } from './fixtures/location-history.ts';
import { geographicEvidence } from '../server/geography/geometry.ts';
const owner = 'a'.repeat(64), other = 'b'.repeat(64);
function setup(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'history-store-test-'));
  let clock = Date.parse('2026-11-02T12:00:00Z'), authorized = true, revoked = false;
  const bridge = new Bridge(join(directory, 'bridge.json'), new WebhookSender(async (_url, raw) => { const e = JSON.parse(raw); return {status: 200, body: JSON.stringify(e.type === 'verification' ? {challenge: e.challenge} : {})}; }), ['callback.example.test']);
  const options = {now: () => clock, ownerAuthorized: (id: string) => authorized && [owner, other].includes(id), ownerRevoked: (id: string) => revoked && id === owner,
    announce: (input: any, guard: () => boolean) => bridge.sendMessage(input, guard)};
  let store = new LocationHistoryStore(join(directory, 'history'), options);
  t.after(() => { store.close(); bridge.close(); rmSync(directory, {recursive: true, force: true}); });
  const control = (action: string, scenario?: string, epoch = store.status(owner).historyEpoch) => store.control({protocol: 1, epoch, action, ...(scenario ? {scenario} : {})}, owner);
  const fix = () => ({latitude: 10.0005, longitude: 10.0005, accuracy: 8, measured_at: new Date(clock).toISOString()});
  const ingest = (sharing = 'session-a', metadata = {protocol: 1, epoch: store.status(owner).historyEpoch, timezone: 'Etc/UTC', utc_offset_minutes: 0}) => store.ingest(fix(), sharing, metadata, owner);
  return {get store() {return store;}, bridge, directory, control, fix, ingest,
    advance(ms: number) {clock += ms;}, revoke() {authorized = false; revoked = true;}, setAuthorization(value: boolean) {authorized = value;},
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
test('production runtime rejects all former test controls', t => {
  const h = setup(t); h.control('enable');
  for (const action of ['simulate', 'finish_simulation']) assert.throws(() => h.control(action, 'walk'));
  assert.equal('historyBeta' in h.store.status(owner), false);
});
test('historical answer uses ordinary linked conversation with access recheck', async t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  await h.bridge.subscribe({name: 'utterance.created', arguments: {session_id: 'personal-g2'}, delivery: {mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64')}});
  const question = await h.bridge.submit({id: randomUUID(), text: 'Which fictional road?'});
  const read = h.store.read() as any;
  const answer = {history_context_id: read.history_context_id, utterance_id: question.id, text: 'The fictional east road.'};
  await h.store.respond(answer); await h.store.respond(answer);
  assert.equal(h.bridge.history().find(x => x.id === question.id)?.reply, answer.text);
  assert.equal(h.bridge.outboundHistory().length, 0);
  h.control('disable'); assert.throws(() => h.store.respond(answer));
});
test('existing geographic evidence is attached without acquiring another map', t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  h.store.attachGeography(h.fix(), geographicEvidence(h.fix(), historyGeography), owner);
  h.restart(); const read = h.store.read({detail: 'observations'}) as any;
  assert.equal(read.entries[0].geography.status, 'available');
  assert.ok(read.entries[0].geography.lines.length > 0);
});

test('a queued historical reply rechecks deletion before the normal reply commit', async t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  await h.bridge.subscribe({name: 'utterance.created', arguments: {session_id: 'personal-g2'}, delivery: {mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64')}});
  const question = await h.bridge.submit({id: randomUUID(), text: 'Which fictional road?'});
  const read = h.store.read() as any;
  const pending = h.store.respond({history_context_id: read.history_context_id, utterance_id: question.id, text: 'Must not arrive.'});
  h.control('delete');
  await assert.rejects(pending, /Historical access changed/);
  assert.equal(h.bridge.history().find(x => x.id === question.id)?.reply, undefined);
  assert.equal(h.store.status(owner).historyCount, 0);
});

test('retention pruning preserves negotiated uploads and recent replies while expiring old evidence', async t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  const epoch = h.store.status(owner).historyEpoch;
  h.advance(HISTORY_RETENTION_MS - 30_000); h.ingest();
  await h.bridge.subscribe({name: 'utterance.created', arguments: {session_id: 'personal-g2'}, delivery: {mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64')}});
  const question = await h.bridge.submit({id: randomUUID(), text: 'Recent evidence?'});
  const old = h.store.read() as any;
  const recent = h.store.read({start_at: h.fix().measured_at}) as any;
  h.advance(31_000);
  assert.equal(h.ingest('session-a', {protocol: 1, epoch, timezone: 'Etc/UTC', utc_offset_minutes: 0}), true);
  assert.equal(h.store.status(owner).historyEpoch, epoch);
  assert.equal(h.store.status(owner).historyCount, 2);
  await h.store.respond({history_context_id: recent.history_context_id, utterance_id: question.id, text: 'The recent point is retained.'});
  assert.throws(() => h.store.respond({history_context_id: old.history_context_id, utterance_id: question.id, text: 'Expired evidence.'}));
  h.control('disable', undefined, epoch);
  assert.equal(h.store.status(owner).historyEnabled, false);
});

test('one history context supports different linked follow-ups with idempotent retries', async t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  await h.bridge.subscribe({name: 'utterance.created', arguments: {session_id: 'personal-g2'}, delivery: {mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64')}});
  const question = await h.bridge.submit({id: randomUUID(), text: 'Explain the fictional walk.'});
  const context = (h.store.read() as any).history_context_id;
  const send = (text: string) => h.store.respond({history_context_id: context, utterance_id: question.id, text});
  const first = await send('The fictional east road.') as any;
  const followup = await send('Then the fictional north road.') as any;
  assert.notEqual(first.message_id, followup.message_id);
  assert.deepEqual(await send('Then the fictional north road.'), followup);
  assert.equal(h.bridge.history().find(x => x.id === question.id)?.reply, 'The fictional east road.');
  assert.equal(h.bridge.outboundHistory().length, 1);
  assert.equal(h.bridge.outboundHistory()[0].reply, 'Then the fictional north road.');
});


test('transient authorization failure blocks access without deleting history or consent', async t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  const epoch = h.store.status(owner).historyEpoch;
  h.setAuthorization(false);
  assert.equal(h.store.read().status, 'unavailable');
  assert.equal(h.ingest('session-a', {protocol: 1, epoch, timezone: 'Etc/UTC', utc_offset_minutes: 0}), false);
  h.store.maintain(); h.restart();
  assert.equal(h.store.read().status, 'unavailable');
  h.setAuthorization(true);
  assert.equal(h.store.status(owner).historyEnabled, true);
  assert.equal(h.store.status(owner).historyCount, 1);
  assert.equal((h.store.read() as any).entries.length, 1);
  // Confirmed revocation remains a different, destructive signal.
  h.revoke(); h.store.maintain(); h.setAuthorization(true);
  assert.equal(h.store.status(owner).historyEnabled, false);
  assert.equal(h.store.status(owner).historyCount, 0);
});


test('upgrade removes legacy simulation state while preserving real observations and explicit consent', t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  h.store.close();
  const db = new DatabaseSync(join(h.directory, 'history/history.sqlite'));
  const state = JSON.parse((db.prepare('SELECT data FROM state WHERE id=1').get() as {data: string}).data);
  state.scenario = 'walk'; state.reference = Date.parse(h.fix().measured_at);
  db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(state));
  db.exec('CREATE TABLE simulation(id TEXT PRIMARY KEY, measured INTEGER NOT NULL, data TEXT NOT NULL)');
  const fixture = historyFixture('walk', state.reference);
  for (const row of fixture.history.snapshot()) db.prepare('INSERT INTO simulation VALUES(?,?,?)').run(row.id, Date.parse(row.measured_at), JSON.stringify(row));
  db.close(); h.restart();
  assert.equal(h.store.status(owner).historyCount, 1); assert.equal(h.store.status(owner).historyEnabled, true);
  assert.equal((h.store.read() as any).source, 'phone_location');
  const check = new DatabaseSync(join(h.directory, 'history/history.sqlite'), {readOnly: true});
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='simulation'").get(), undefined);
  const saved = JSON.parse((check.prepare('SELECT data FROM state WHERE id=1').get() as {data: string}).data);
  assert.equal(saved.scenario, null); assert.equal(saved.reference, null); check.close();
});

test('full deletion lets another authorized pairing opt in without inheriting consent or data', t => {
  const h = setup(t); h.control('enable'); h.advance(1000); h.ingest();
  const oldEpoch = h.store.status(owner).historyEpoch;
  h.control('disable'); assert.equal(h.store.status(other).historyEpoch, null);
  h.control('delete'); h.restart();
  const state = h.store.status(other); assert.equal(state.historyEnabled, false); assert.equal(state.historyCount, 0); assert.ok(state.historyEpoch);
  assert.throws(() => h.store.control({protocol: 1, epoch: oldEpoch, action: 'enable'}, owner));
  h.store.control({protocol: 1, epoch: state.historyEpoch, action: 'enable'}, other);
  assert.equal(h.store.status(other).historyEnabled, true); assert.equal(h.store.status(owner).historyEpoch, null);
  h.advance(1000); assert.equal(h.ingest('old-owner', {protocol: 1, epoch: oldEpoch, timezone: 'Etc/UTC', utc_offset_minutes: 0}), false);
});

test('bounded pages survive later live fixes and map attachment but not changes inside their interval', t => {
  const h = setup(t); h.control('enable');
  for (let n = 0; n < 4; n++) { h.advance(1000); h.ingest(); }
  const first = h.store.read({detail: 'observations', limit: 1}) as any; assert.ok(first.next_cursor);
  h.advance(1000); h.ingest(); h.store.attachGeography(h.fix(), geographicEvidence(h.fix(), historyGeography), owner);
  const second = h.store.read({cursor: first.next_cursor}) as any;
  assert.equal(second.coverage.observation_count, 4); assert.notEqual(second.entries[0].id, first.entries[0].id);
  assert.equal((h.store.read({detail: 'observations'}) as any).coverage.observation_count, 5);
  const future = h.store.read({start_at: new Date(Date.parse(h.fix().measured_at) - 60_000).toISOString(), end_at: new Date(Date.parse(h.fix().measured_at) + 60_000).toISOString(), detail: 'observations', limit: 1}) as any;
  h.advance(1000); h.ingest(); assert.throws(() => h.store.read({cursor: future.next_cursor}), /page is no longer available/);
  h.control('delete'); assert.equal(h.store.read({cursor: second.next_cursor}).status, 'unavailable');
});

test('phone time projection is owner bound, omits location and expires with its source', t=>{
 const h=setup(t),dates=['2026-11-02'];
 assert.equal(h.store.readPhoneTime(dates,owner).evidence.status,'unavailable');
 h.control('enable');assert.equal(h.store.readPhoneTime(dates,owner).evidence.status,'empty');
 h.advance(1000);h.ingest();
 assert.equal(h.store.readPhoneTime(dates,other).evidence.status,'unavailable');
 const read=h.store.readPhoneTime(dates,owner);assert.equal(read.evidence.status,'available');
 assert.equal(read.allowed?.(),true);
 const raw=JSON.stringify(read.evidence);assert.ok(!raw.includes('latitude'));assert.ok(!raw.includes('longitude'));assert.ok(!raw.includes('geography'));
 h.setAuthorization(false);assert.equal(read.allowed?.(),false);h.setAuthorization(true);
 h.advance(5*60_000);assert.equal(read.allowed?.(),false);
 const retained=h.store.readPhoneTime(dates,owner);assert.equal(retained.allowed?.(),true);
 h.revoke();assert.equal(retained.allowed?.(),false);
 assert.equal(h.store.readPhoneTime(dates,owner).evidence.status,'unavailable');
});
