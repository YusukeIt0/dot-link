import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {Bridge} from '../server/bridge.ts';
import {HealthContext} from '../server/health/context.ts';
import {normalizeProfile} from '../server/health/data.ts';
import {PolarAPI} from '../server/health/polar.ts';
import {HealthVault} from '../server/health/vault.ts';
import {SharingActivation} from '../server/sharing-activation.ts';
import {WebhookSender} from '../server/webhook.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const owner = 'synthetic-owner';
const session = {session_id: 'personal-g2'};
const hosts = ['callback.example.test'];
const subscription = (name: string, route: string) => ({
  name, arguments: session, delivery: {mode: 'webhook', url: `https://${hosts[0]}/${route}`, secret: 'whsec_' + Buffer.alloc(32, 7).toString('base64')},
});
const speech = subscription('utterance.created', 'speech');
const updates = subscription('health.updated', 'polar');

async function fixture(t: TestContext, initialStatus = 202) {
  const directory = mkdtempSync(join(tmpdir(), 'polar-activation-'));
  const path = join(directory, 'health', 'state.enc');
  const key = randomBytes(32);
  let now = Date.now(), locked = false;
  const clock = () => now;
  const connection = {clientId: 'fixture', clientSecret: 'secret-fixture', accessToken: 'token-fixture', userId: 7, expiresAt: now + 86_400_000};
  // An existing v1 vault with consent already granted, as written before #377.
  new HealthVault(path).write(key, {version: 1, connection, owner, enabled: true, deletedBefore: 0, profileDeleted: false, observations: []});
  const eventIds: string[] = [];
  const sender = new WebhookSender(async (_url, raw) => {
    const event = JSON.parse(raw);
    if (event.type === 'verification') return {status: 200, body: JSON.stringify({challenge: event.challenge})};
    if (event.name === 'utterance.created' && event.data.text.includes('health.updated')) eventIds.push(event.eventId);
    return {status: initialStatus, body: '{}'};
  });
  const api = new PolarAPI();
  api.collect = async () => ({observations: []});
  api.profile = async () => normalizeProfile({height: 170}, now);

  const open = async () => {
    const bridge = new Bridge(join(directory, 'bridge.json'), sender, hosts, undefined, {now: clock});
    const health = new HealthContext(path, {
      key: async () => locked ? undefined : Buffer.from(key), now: clock, ownerAuthorized: candidate => candidate === owner,
      ownerRevoked: () => false, announce: async () => ({}), sender, hosts, api,
    });
    const activation = new SharingActivation(health.activationStore, bridge, health, clock, 'health');
    await health.setup({action: 'status'});
    const close = () => { activation.close(); health.close(); bridge.close(); };
    return {bridge, health, activation, close};
  };
  let app = await open();
  t.after(() => { app.close(); rmSync(directory, {recursive: true, force: true}); });
  await app.bridge.subscribe(speech);
  await settle();
  return {
    directory, path, key, eventIds, get app() { return app; },
    restart: async () => { app.close(); app = await open(); await settle(); },
    control: (action: string) => app.health.control({protocol: 1, epoch: app.health.status(owner).healthEpoch, action}, owner),
    advance: (ms: number) => { now += ms; },
    setLocked: (value: boolean) => { locked = value; },
  };
}

test('an accepted Polar request survives restart, a health refresh and deletion of archived history', async t => {
  const f = await fixture(t);
  assert.equal(f.eventIds.length, 1);
  const requestId = f.app.activation.pending()[0].request_id;
  assert.equal(f.eventIds[0], `evt_${requestId}`);
  await f.restart();
  assert.deepEqual(f.eventIds, [`evt_${requestId}`]);
  assert.equal(f.app.activation.pending()[0].request_id, requestId);
  await f.control('refresh');
  await settle();
  await f.restart();
  assert.deepEqual(f.eventIds, [`evt_${requestId}`]);
  assert.equal(f.app.activation.pending()[0].request_id, requestId);

  // Activation bookkeeping must not change the strict legacy format or create
  // a plaintext record of the owner's health-sharing decision.
  const legacy = new HealthVault(f.path).read(f.key) as Record<string, unknown>;
  assert.deepEqual(Object.keys(legacy).sort(), ['activationStopped', 'connection', 'deletedBefore', 'disconnectPending',
    'enabled', 'observations', 'owner', 'profile', 'profileDeleted', 'version'].sort());
  for (const file of readdirSync(f.directory, {recursive: true, withFileTypes: true})) {
    if (file.isFile() && file.name !== 'bridge.json') {
      const content = readFileSync(join(file.parentPath, file.name));
      for (const value of [requestId, 'accepted', 'token-fixture', owner]) assert.equal(content.includes(value), false);
    }
  }
  const history = await f.app.health.archiveStatus(owner);
  assert.ok(history.epoch);
  await f.app.health.archiveControl(owner, history.epoch, {action: 'delete'});
  await f.restart();
  assert.deepEqual(f.eventIds, [`evt_${requestId}`]);
  assert.equal(f.app.activation.pending()[0].request_id, requestId);
});

test('Polar delivery retries retain the original request ID, deadline and three-attempt budget across restarts', async t => {
  const f = await fixture(t, 503);
  const first = f.eventIds[0];
  assert.ok(first);
  await f.restart();
  assert.deepEqual(f.eventIds, [first]);
  f.advance(5_001);
  await f.app.activation.sync();
  assert.deepEqual(f.eventIds, [first, first]);
  await f.restart();
  f.advance(10_001);
  await f.app.activation.sync();
  assert.deepEqual(f.eventIds, [first, first, first]);
  await f.restart();
  f.advance(60_000);
  await f.app.activation.sync();
  assert.deepEqual(f.eventIds, [first, first, first]);
});

test('an active subscription or deliberate stop survives restart; a new sharing choice gets a fresh request', async t => {
  const f = await fixture(t);
  const first = f.eventIds[0];
  assert.ok(first);
  await f.app.health.subscribe(updates);
  await settle();
  await f.restart();
  assert.deepEqual(f.app.activation.pending(), []);
  assert.deepEqual(f.eventIds, [first]);
  await f.app.health.unsubscribe({name: updates.name, arguments: session, delivery: {mode: 'webhook', url: updates.delivery.url}});
  await f.restart();
  assert.deepEqual(f.app.activation.pending(), []);
  assert.deepEqual(f.eventIds, [first]);
  await f.control('disable');
  await f.control('enable');
  await settle();
  assert.equal(f.eventIds.length, 2);
  assert.notEqual(f.eventIds[1], first);
  await f.restart();
  assert.equal(f.eventIds.length, 2);
});

test('locked Polar storage leaves ordinary speech and replies available; opening the vault resumes the same request', async t => {
  const f = await fixture(t);
  const first = f.eventIds[0];
  assert.ok(first);
  f.setLocked(true);
  await f.restart();
  assert.equal(f.app.health.setupStatus().status, 'locked');
  assert.deepEqual(f.app.activation.pending(), []);
  const utterance = randomUUID();
  await f.app.bridge.submit({id: utterance, text: 'An ordinary question'});
  await f.app.bridge.reply({utterance_id: utterance, text: 'An ordinary answer'});
  assert.equal(f.app.bridge.history()[0].reply, 'An ordinary answer');
  f.setLocked(false);
  await f.restart();
  assert.deepEqual(f.eventIds, [first]);
  assert.equal(`evt_${f.app.activation.pending()[0].request_id}`, first);
});

test('a health grant established just before shutdown can renew after expiring during downtime', async t => {
  const f = await fixture(t);
  const first = f.eventIds[0];
  assert.ok(first);
  // The provider's registration succeeds after the delivery loop has stopped.
  // No activation tick can mark the accepted request complete before restart.
  f.app.activation.close();
  await f.app.health.subscribe({...updates, ttlMs: 1_000});
  f.advance(1_001);
  await f.restart();
  assert.equal(f.eventIds.length, 2);
  assert.notEqual(f.eventIds[1], first);
  await f.restart();
  assert.equal(f.eventIds.length, 2);
});

test('an old client switching consent off and back on cannot reuse an earlier accepted request', async t => {
  const f = await fixture(t);
  const first = f.eventIds[0];
  assert.ok(first);
  f.app.close();
  const oldVault = new HealthVault(f.path);
  const state = oldVault.read(f.key) as Record<string, unknown>;
  oldVault.write(f.key, {...state, enabled: false});
  oldVault.write(f.key, {...state, enabled: true});
  await f.restart();
  assert.equal(f.eventIds.length, 2);
  assert.notEqual(f.eventIds[1], first);
  await f.restart();
  assert.equal(f.eventIds.length, 2);
});

test('a legacy Polar reset and reconnection under a new key preserves an explicit stop and requests fresh enrollment once', async t => {
  const f = await fixture(t);
  const original = f.eventIds[0];
  assert.ok(original);
  f.app.close();
  const vault = new HealthVault(f.path);
  const old = vault.read(f.key) as {connection: Record<string, unknown>};
  // The older client knows only the v1 vault. Its reset deletes that file
  // and replaces the Keychain key; the new client's encrypted receipt remains.
  vault.remove();
  randomBytes(32).copy(f.key);
  const connection = {...old.connection, accessToken: 'new-fixture-token'};
  const state = {version: 1, connection, owner, enabled: true, deletedBefore: 0, profileDeleted: false, observations: []};
  vault.write(f.key, {...state, activationStopped: true});
  await f.restart();
  assert.equal(f.app.health.setupStatus().sharing, true);
  assert.deepEqual(f.app.activation.pending(), []);
  assert.deepEqual(f.eventIds, [original]);

  // The same person makes a fresh sharing choice in the older client.
  f.app.close();
  vault.write(f.key, {...state, enabled: false});
  vault.write(f.key, {...state, activationStopped: false});
  await f.restart();
  assert.equal(f.app.health.setupStatus().sharing, true);
  assert.equal(f.eventIds.length, 2);
  const replacement = f.eventIds[1];
  assert.notEqual(replacement, original);
  await f.restart();
  assert.equal(`evt_${f.app.activation.pending()[0].request_id}`, replacement);
  assert.deepEqual(f.eventIds, [original, replacement]);
});

test('temporary receipt read denial leaves its ciphertext and accepted request untouched', async t => {
  const f = await fixture(t);
  const first = f.eventIds[0];
  assert.ok(first);
  const receipt = join(f.path + '.history', 'activation.enc');
  const before = readFileSync(receipt);
  const read = HealthVault.prototype.read;
  let denials = 0;
  const fault = t.mock.method(HealthVault.prototype, 'read', function(this: HealthVault, key: Buffer) {
    if (this.path === receipt) {
      denials++;
      throw Object.assign(new Error('synthetic read denial'), {code: 'EACCES'});
    }
    return read.call(this, key);
  });
  await f.restart();
  assert.ok(denials > 0);
  assert.deepEqual(f.app.activation.pending(), []);
  assert.deepEqual(f.eventIds, [first]);
  assert.deepEqual(readFileSync(receipt), before);
  fault.mock.restore();
  await f.restart();
  assert.equal(`evt_${f.app.activation.pending()[0].request_id}`, first);
  assert.deepEqual(f.eventIds, [first]);
});

test('switching conversation destinations creates one new Polar request for the new destination', async t => {
  const f = await fixture(t);
  const first = f.eventIds[0];
  assert.ok(first);
  await f.app.bridge.unsubscribe({name: speech.name, arguments: session, delivery: {mode: 'webhook', url: speech.delivery.url}});
  assert.deepEqual(f.app.activation.pending(), []);
  await f.app.bridge.subscribe(subscription('utterance.created', 'replacement'));
  await settle();
  assert.equal(f.eventIds.length, 2);
  assert.notEqual(f.eventIds[1], first);
  await f.restart();
  assert.equal(f.eventIds.length, 2);
});

test('an unavailable activation receipt cannot block a durable stop or interrupt ordinary conversation', async t => {
  const f = await fixture(t);
  const first = f.eventIds[0];
  assert.ok(first);
  const receipt = join(f.path + '.history', 'activation.enc');
  renameSync(receipt, receipt + '.unavailable');
  mkdirSync(receipt);
  await f.restart();
  assert.deepEqual(f.app.activation.pending(), []);
  assert.deepEqual(f.eventIds, [first]);
  await f.control('disable');
  await f.restart();
  assert.equal(f.app.health.setupStatus().sharing, false);
  const utterance = randomUUID();
  await f.app.bridge.submit({id: utterance, text: 'Continue the conversation'});
  await f.app.bridge.reply({utterance_id: utterance, text: 'Still here'});
  assert.equal(f.app.bridge.history()[0].reply, 'Still here');
  rmSync(receipt, {recursive: true});
  renameSync(receipt + '.unavailable', receipt);
  await f.restart();
  assert.equal(f.app.health.setupStatus().sharing, false);
  assert.deepEqual(f.eventIds, [first]);
});

function failReceiptWrites(t: TestContext, path: string) {
  const receipt = join(path + '.history', 'activation.enc');
  const write = HealthVault.prototype.write;
  let failedWrites = 0;
  const fault = t.mock.method(HealthVault.prototype, 'write', function(this: HealthVault, ...args: Parameters<typeof write>) {
    if (this.path === receipt) {
      failedWrites++;
      throw new Error('synthetic receipt write failure');
    }
    return write.apply(this, args);
  });
  return {failures: () => failedWrites, restore: () => fault.mock.restore()};
}

test('a failed activation checkpoint cannot roll back the owner’s deletion', async t => {
  const f = await fixture(t);
  const first = f.eventIds[0];
  assert.ok(first);
  const fault = failReceiptWrites(t, f.path);
  await f.control('refresh');
  await settle();
  assert.ok(fault.failures() > 0);
  assert.equal(f.app.health.setupStatus().sharing, true);
  assert.deepEqual(f.eventIds, [first]);
  await f.control('delete');
  fault.restore();
  await f.restart();
  const saved = new HealthVault(f.path).read(f.key) as {enabled: boolean; profileDeleted: boolean};
  assert.equal(saved.enabled, false);
  assert.equal(saved.profileDeleted, true);
  assert.deepEqual(f.app.activation.pending(), []);
  assert.deepEqual(f.eventIds, [first]);
});

test('a later successful checkpoint preserves the accepted request after a temporary receipt failure', async t => {
  const f = await fixture(t);
  const id = f.app.activation.pending()[0].request_id;
  const fault = failReceiptWrites(t, f.path);
  await f.control('refresh');
  await settle();
  assert.ok(fault.failures() > 0);
  fault.restore();
  await f.control('refresh');
  await settle();
  await f.restart();
  assert.equal(f.app.activation.pending()[0].request_id, id);
  assert.deepEqual(f.eventIds, [`evt_${id}`]);
});
