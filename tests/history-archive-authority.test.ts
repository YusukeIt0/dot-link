import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ArchiveAuthority } from '../server/history/archive-authority.ts';
import type { ArchiveKeyProvider } from '../server/history/archive-key.ts';

const owner = 'a'.repeat(64);
const otherOwner = 'b'.repeat(64);
const recordWeather = {action: 'set', source: 'weather', enabled: true} as const;
const stopWeather = {...recordWeather, enabled: false} as const;
const eraseWeather = {action: 'delete', source: 'weather'} as const;

function fixture(t: TestContext, now: () => number = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), 'history-archive-authority-'));
  const keys = new Map<string, Buffer>();
  const owners = new Map<string, 'authorized' | 'unavailable' | 'revoked'>([[owner, 'authorized']]);
  const provider: ArchiveKeyProvider = {
    async create() {
      const key = randomBytes(32);
      const wrapped = randomBytes(64).toString('base64');
      keys.set(wrapped, Buffer.from(key));
      return {key, wrapped};
    },
    async open(wrapped) {
      const key = keys.get(wrapped);
      if (!key) throw new Error('Synthetic key unavailable');
      return Buffer.from(key);
    },
  };
  const running = new Set<ArchiveAuthority>();
  const open = () => {
    const authority = new ArchiveAuthority(directory, provider, {
      ownerStatus: subject => owners.get(subject) ?? 'revoked',
      now,
    });
    running.add(authority);
    return authority;
  };
  function close(authority: ArchiveAuthority) {
    authority.close();
    running.delete(authority);
  }
  t.after(() => {
    for (const authority of running) authority.close();
    rmSync(directory, {recursive: true, force: true});
  });
  return {directory, open, close, owners, keys};
}

function activeWeather(a: ArchiveAuthority) {
  const lease = a.capture(owner, 'weather');
  assert.ok(lease, 'Expected an authorized weather archive');
  return lease;
}

function keyIdentity(key: Buffer, generation: string) {
  return {fingerprint: createHash('sha256').update(key).digest('hex'), generation};
}

test('first-run status and requests from an unauthorized owner never provision archive keys', async t => {
  const f = fixture(t);
  const a = f.open();
  const first = await a.status(owner);
  assert.equal(first.period, '7d');
  assert.deepEqual(first.sources, {location: false, weather: false, mobility: false});
  assert.equal(a.capture(owner, 'weather'), undefined);
  await assert.rejects(() => a.status(otherOwner));
  await assert.rejects(() => a.control(otherOwner, first.epoch, recordWeather));
  assert.equal(a.capture(otherOwner, 'weather'), undefined);
  assert.equal(f.keys.size, 0);
});

test('reopening the archive restores source choices, duration and the original source key', async t => {
  const f = fixture(t);
  const first = f.open();
  const off = await first.status(owner);
  const on = await first.control(owner, off.epoch, recordWeather);
  await first.control(owner, on.epoch, {action: 'period', period: '1m'});
  const before = first.use(activeWeather(first), keyIdentity);
  const created = f.keys.size;
  assert.ok(created > 0);
  f.close(first);

  const restarted = f.open();
  const settings = await restarted.status(owner);
  assert.equal(settings.period, '1m');
  assert.deepEqual(settings.sources, {location: false, weather: true, mobility: false});
  assert.deepEqual(restarted.use(activeWeather(restarted), keyIdentity), before);
  assert.equal(restarted.use(activeWeather(restarted), (_key, _generation, period) => period), '1m');
  assert.equal(f.keys.size, created);
});

test('stopping fences delayed work while delete retires the weather key without touching mobility', async t => {
  const f = fixture(t);
  const a = f.open();
  const initial = await a.status(owner);
  const weather = await a.control(owner, initial.epoch, recordWeather);
  const both = await a.control(owner, weather.epoch, {action: 'set', source: 'mobility', enabled: true});
  const oldLease = activeWeather(a);
  const original = a.use(oldLease, keyIdentity);
  const otherLease = a.capture(owner, 'mobility');
  assert.ok(otherLease);
  const mobilityIdentity = a.use(otherLease, keyIdentity);

  const stopped = await a.control(owner, both.epoch, stopWeather);
  assert.equal(a.capture(owner, 'weather'), undefined);
  let disclosures = 0;
  const countDisclosure = () => ++disclosures;
  assert.throws(() => a.use(oldLease, countDisclosure));
  const resumed = await a.control(owner, stopped.epoch, recordWeather);
  assert.throws(() => a.use(oldLease, countDisclosure));
  const resumedLease = activeWeather(a);
  assert.deepEqual(a.use(resumedLease, keyIdentity), original);

  const erased = await a.control(owner, resumed.epoch, eraseWeather);
  assert.equal(erased.sources.weather, false);
  assert.throws(() => a.use(resumedLease, countDisclosure));
  await a.control(owner, erased.epoch, recordWeather);
  assert.throws(() => a.use(resumedLease, countDisclosure));
  const replacement = a.use(activeWeather(a), keyIdentity);
  assert.notEqual(replacement.fingerprint, original.fingerprint);
  assert.notEqual(replacement.generation, original.generation);
  const remaining = a.capture(owner, 'mobility');
  assert.ok(remaining);
  assert.deepEqual(a.use(remaining, keyIdentity), mobilityIdentity);
  assert.equal(disclosures, 0);
});

test('a temporarily unreadable pairing blocks access, and revoking the owner permanently retires the key', async t => {
  const f = fixture(t);
  const a = f.open();
  const initial = await a.status(owner);
  await a.control(owner, initial.epoch, recordWeather);
  const lease = activeWeather(a);
  const original = a.use(lease, keyIdentity);
  f.owners.set(owner, 'unavailable');
  await assert.rejects(() => a.status(owner));
  assert.equal(a.capture(owner, 'weather'), undefined);
  let used = false;
  assert.throws(() => a.use(lease, () => { used = true; }));
  f.owners.set(owner, 'authorized');
  await a.status(owner);
  assert.deepEqual(a.use(activeWeather(a), keyIdentity), original);

  f.owners.set(owner, 'revoked');
  await a.revoke(owner);
  assert.throws(() => a.use(lease, () => { used = true; }));
  assert.equal(used, false);
  f.close(a);
  f.owners.set(owner, 'authorized');
  const restarted = f.open();
  const settings = await restarted.status(owner);
  assert.equal(settings.sources.weather, false);
  await restarted.control(owner, settings.epoch, recordWeather);
  assert.notEqual(restarted.use(activeWeather(restarted), keyIdentity).fingerprint, original.fingerprint);
});

test('a second paired device cannot claim the first owner’s archive until revocation is confirmed', async t => {
  const f = fixture(t);
  f.owners.set(otherOwner, 'authorized');
  const a = f.open();
  const initial = await a.status(owner);
  const grant = await a.control(owner, initial.epoch, recordWeather);
  const first = a.use(activeWeather(a), keyIdentity);
  await assert.rejects(() => a.status(otherOwner));
  await assert.rejects(() => a.control(otherOwner, grant.epoch, eraseWeather));
  assert.equal(a.capture(otherOwner, 'weather'), undefined);
  f.owners.set(owner, 'unavailable');
  await assert.rejects(() => a.status(otherOwner));
  f.owners.set(owner, 'revoked');
  const empty = await a.status(otherOwner);
  assert.equal(empty.sources.weather, false);
  await a.control(otherOwner, empty.epoch, recordWeather);
  const secondLease = a.capture(otherOwner, 'weather');
  assert.ok(secondLease);
  assert.notEqual(a.use(secondLease, keyIdentity).fingerprint, first.fingerprint);
  f.owners.set(owner, 'authorized');
  await assert.rejects(() => a.status(owner));
  assert.equal(a.capture(owner, 'weather'), undefined);
});

test('concurrent authorities cannot both modify one revision or use a lease after another writer deletes', async t => {
  const f = fixture(t);
  const a = f.open();
  const initial = await a.status(owner);
  await a.control(owner, initial.epoch, recordWeather);
  const b = f.open();
  const [fromA, fromB] = await Promise.all([a.status(owner), b.status(owner)]);
  const writes = await Promise.allSettled([
    a.control(owner, fromA.epoch, {action: 'period', period: '1m'}),
    b.control(owner, fromB.epoch, {action: 'period', period: '6m'}),
  ]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  const surviving = await a.status(owner);
  const expectedPeriod = writes[0].status === 'fulfilled' ? '1m' : '6m';
  assert.equal(surviving.period, expectedPeriod);
  const lease = activeWeather(a);
  const refreshed = await b.status(owner);
  await b.control(owner, refreshed.epoch, eraseWeather);
  let disclosures = 0;
  assert.throws(() => a.use(lease, () => ++disclosures));
  assert.equal(disclosures, 0);
});

test('a wrong key after restart cannot open an archive or replace it with new key material', async t => {
  const f = fixture(t);
  const a = f.open();
  const off = await a.status(owner);
  await a.control(owner, off.epoch, recordWeather);
  const original = a.use(activeWeather(a), keyIdentity);
  const keys = new Map(f.keys);
  f.close(a);
  for (const wrapped of keys.keys()) f.keys.set(wrapped, randomBytes(32));
  const broken = f.open();
  await assert.rejects(() => broken.status(owner));
  assert.throws(() => broken.capture(owner, 'weather'));
  assert.deepEqual([...f.keys.keys()], [...keys.keys()]);
  for (const [wrapped, key] of keys) f.keys.set(wrapped, key);
  assert.equal((await broken.status(owner)).sources.weather, true);
  assert.deepEqual(broken.use(activeWeather(broken), keyIdentity), original);
});

test('deletion unlinks the source file and an old evidence backup cannot reopen the deleted generation', async t => {
  const f = fixture(t);
  const a = f.open();
  const off = await a.status(owner);
  const on = await a.control(owner, off.epoch, recordWeather);
  const lease = activeWeather(a);
  const at = Date.now() - 1000;
  const window = {fromMs: at, toMs: at + 1};
  const record = {...window, id: 'fictional-forecast', availableAtMs: at, anchorMs: at, version: 1, payload: {temperature: 21}};
  assert.equal(a.put(lease, record), 'stored');
  assert.deepEqual(a.read(lease, window).records.map(row => row.payload), [record.payload]);
  const generationPath = (id: string) => join(f.directory, 'sources', id + '.sqlite');
  const formerFile = generationPath(a.use(lease, keyIdentity).generation);
  const backup = readFileSync(formerFile);
  const erased = await a.control(owner, on.epoch, eraseWeather);
  assert.equal(existsSync(formerFile), false);
  assert.throws(() => a.read(lease, window));
  assert.throws(() => a.put(lease, record));

  await a.control(owner, erased.epoch, recordWeather);
  const fresh = activeWeather(a);
  const liveFile = generationPath(a.use(fresh, keyIdentity).generation);
  const freshDatabase = readFileSync(liveFile);
  writeFileSync(formerFile, backup, {mode: 0o600});
  assert.deepEqual(a.read(fresh, window).records, []);
  writeFileSync(liveFile, backup);
  assert.throws(() => a.read(fresh, window));
  writeFileSync(liveFile, freshDatabase);
  f.close(a);

  const restarted = f.open();
  await restarted.restore();
  assert.equal(existsSync(formerFile), false);
  assert.deepEqual(restarted.read(activeWeather(restarted), window).records, []);
});

test('restore purges a revoked owner’s files even when no client requests status after restart', async t => {
  const f = fixture(t);
  const active = f.open();
  const off = await active.status(owner);
  await active.control(owner, off.epoch, recordWeather);
  const id = active.use(activeWeather(active), keyIdentity).generation;
  const file = join(f.directory, 'sources', id + '.sqlite');
  f.close(active);
  f.owners.set(owner, 'unavailable');
  const restarted = f.open();
  await restarted.restore();
  assert.equal(existsSync(file), true);
  f.owners.set(owner, 'revoked');
  await restarted.restore();
  assert.equal(existsSync(file), false);
  assert.equal(restarted.capture(owner, 'weather'), undefined);
});

test('unattended maintenance erases expired payloads and time indexes while recording is stopped', async t => {
  const at = Date.parse('2026-01-31T16:00:00Z');
  let clock = at;
  const f = fixture(t, () => clock);
  const a = f.open();
  const off = await a.status(owner);
  const on = await a.control(owner, off.epoch, recordWeather);
  const lease = activeWeather(a);
  const window = {fromMs: at, toMs: at + 1};
  const record = {...window, id: 'synthetic-forecast', availableAtMs: at, anchorMs: at, version: 1, payload: 'forecast'.repeat(500)};
  assert.equal(a.put(lease, record), 'stored');
  const path = join(f.directory, 'sources', a.use(lease, keyIdentity).generation + '.sqlite');
  function footprint() {
    const db = new DatabaseSync(path, {readOnly: true});
    try {
      const buckets = Number(db.prepare('SELECT count(*) AS n FROM days').get()?.n);
      const bytes = Number(db.prepare('SELECT coalesce(sum(length(body)),0) AS n FROM entries').get()?.n);
      return {buckets, bytes};
    } finally { db.close(); }
  }
  const before = footprint();
  assert.ok(before.buckets > 0);
  assert.ok(before.bytes > record.payload.length);
  await a.control(owner, on.epoch, stopWeather);
  f.close(a);

  clock += 8 * 86_400_000;
  const restarted = f.open();
  f.owners.set(owner, 'unavailable');
  await restarted.maintain();
  const after = footprint();
  assert.equal(after.buckets, 0);
  assert.ok(after.bytes < before.bytes - record.payload.length);
  assert.equal(restarted.capture(owner, 'weather'), undefined);
  f.owners.set(owner, 'authorized');
  const stopped = await restarted.status(owner);
  assert.equal(stopped.sources.weather, false);
  const longer = await restarted.control(owner, stopped.epoch, {action: 'period', period: '1y'});
  await restarted.control(owner, longer.epoch, recordWeather);
  const current = activeWeather(restarted);
  assert.deepEqual(restarted.read(current, window).records, []);
  assert.equal(restarted.put(current, record), 'expired');
});
