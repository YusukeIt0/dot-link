import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { removeEvenPairings } from '../scripts/lib/pairing-removal.mjs';
import { pairingStatus } from '../scripts/lib/pairing-status.mjs';
import { LocationContext } from '../server/location.ts';
import { WebhookSender } from '../server/webhook.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'dot-pair-remove-'));
  const root = join(directory, '.runtime/pairing');
  const authority = new PairingAuthority(root);
  t.after(() => { chmodSync(join(root, 'sessions'), 0o700); rmSync(directory, { recursive: true, force: true }); });
  const phone = 'http://127.0.0.1:55001';
  const pair = (origin = phone) => authority.exchange(authority.issue('https://fixture.tailtest.ts.net').code, origin)!;
  return { directory, root, authority, phone, pair };
}

test('Mac bulk removal invalidates sessions, recovery and unused codes without changing paused state or history', async t => {
  const f = fixture(t);
  const a = f.pair(), b = f.pair('http://127.0.0.1:55002');
  const invite = f.authority.issue('https://fixture.tailtest.ts.net');
  const paused = '{"stopped":true,"reason":"pause"}';
  const history = '{"fixture":"preserved"}';
  writeFileSync(join(f.directory, '.runtime/lifecycle.json'), paused);
  writeFileSync(join(f.directory, '.runtime/bridge-state.json'), history);
  writeFileSync(join(f.directory, '.runtime/beta-pairing.txt'), JSON.stringify(invite));
  assert.equal((await pairingStatus(f.directory)).evenPairingCount, 2);
  assert.equal((await pairingStatus(f.directory)).evenInvitationCount, 1);
  const removed = await removeEvenPairings(f.directory);
  assert.equal(removed.pairingRemoval, 'removed');
  assert.equal(removed.evenPairingCount, 0);
  assert.equal(removed.evenInvitationCount, 0);
  for (const authority of [f.authority, new PairingAuthority(f.root)]) {
    assert.equal(authority.authorized(a.token, f.phone), false);
    assert.equal(authority.authorized(b.token, 'http://127.0.0.1:55002'), false);
    assert.equal(authority.resume(a.resumeToken!, f.phone), undefined);
    assert.equal(authority.exchange(invite.code, f.phone), undefined);
  }
  assert.equal(readFileSync(join(f.directory, '.runtime/lifecycle.json'), 'utf8'), paused);
  assert.equal(readFileSync(join(f.directory, '.runtime/bridge-state.json'), 'utf8'), history);
  assert.throws(() => readFileSync(join(f.directory, '.runtime/beta-pairing.txt')));
  assert.equal((await removeEvenPairings(f.directory)).pairingRemoval, 'removed', 'repeat is safe');
  const fresh = f.pair();
  assert.equal(f.authority.authorized(fresh.token, f.phone), true);
  assert.equal((await pairingStatus(f.directory)).evenPairingCount, 1);
});

test('a failed revocation commit reports failure and never claims that still-valid credentials were removed', async t => {
  const f = fixture(t), saved = f.pair();
  // A directory prevents the atomic rename, without depending on root/non-root permissions.
  mkdirSync(join(f.root, 'generation.json'));
  const result = await removeEvenPairings(f.directory);
  assert.equal(result.pairingRemoval, 'failed');
  assert.equal(result.evenPairingKnown, false);
  rmSync(join(f.root, 'generation.json'), { recursive: true });
  assert.equal(f.authority.authorized(saved.token, f.phone), true);
  assert.equal((await removeEvenPairings(f.directory)).pairingRemoval, 'removed');
});

test('old records written after the revocation boundary cannot resurrect access, even without cleanup', async t => {
  const f = fixture(t), saved = f.pair();
  const invite = f.authority.issue('https://fixture.tailtest.ts.net');
  const records = ['sessions', 'recoveries', 'invitations'].flatMap(kind =>
    readdirSync(join(f.root, kind)).map(name => ({ path: join(f.root, kind, name), data: readFileSync(join(f.root, kind, name)) })));
  f.authority.revokeAll();
  for (const record of records) writeFileSync(record.path, record.data);
  assert.equal(f.authority.authorized(saved.token, f.phone), false);
  assert.equal(f.authority.resume(saved.resumeToken!, f.phone), undefined);
  assert.equal(f.authority.exchange(invite.code, f.phone), undefined);
  assert.equal(f.authority.allowsOrigin(f.phone), false);
  assert.equal(f.authority.allowsPairingOrigin(f.phone), false);
  assert.equal((await pairingStatus(f.directory)).evenPaired, false);
  assert.equal((await pairingStatus(f.directory)).evenInvitationCount, 0);
});

test('failed file cleanup cannot leave a revoked credential authorized', t => {
  if (process.getuid?.() === 0) { t.skip('requires non-root filesystem permissions'); return; }
  const f = fixture(t), saved = f.pair();
  chmodSync(join(f.root, 'sessions'), 0o500);
  assert.equal(f.authority.revokeAll().cleanupComplete, false);
  assert.equal(readdirSync(join(f.root, 'sessions')).length, 1);
  assert.equal(f.authority.authorized(saved.token, f.phone), false);
  assert.equal(f.authority.resume(saved.resumeToken!, f.phone), undefined);
});

test('pre-generation legacy registrations are revoked, never assigned an invented device identity', async t => {
  const f = fixture(t), saved = f.pair();
  for (const kind of ['sessions', 'recoveries']) {
    for (const name of readdirSync(join(f.root, kind))) {
      const path = join(f.root, kind, name), record = JSON.parse(readFileSync(path, 'utf8'));
      delete record.generation;
      writeFileSync(path, JSON.stringify(record));
    }
  }
  const subject = f.authority.subject(saved.token, f.phone)!;
  assert.equal(f.authority.authorizedSubject(subject), true);
  assert.equal((await pairingStatus(f.directory)).evenPairingCount, 1);
  f.authority.revokeAll();
  assert.equal(f.authority.authorizedSubject(subject), false);
  assert.equal(f.authority.authorized(saved.token, f.phone), false);
});

test('bulk removal stops existing location context, delayed updates and queued announcements without restarting the bridge', async t => {
  const f = fixture(t), saved = f.pair();
  const subject = f.authority.subject(saved.token, f.phone)!;
  const sender = new WebhookSender(async () => ({ status: 200, body: '{}' }));
  let announced = 0;
  const location = new LocationContext(join(f.directory, 'location.json'), sender, [],
    async (_input, guard) => { assert.equal(guard(), true); announced++; return {}; },
    Date.now, owner => f.authority.authorizedSubject(owner));
  t.after(() => location.close());
  const sharing = randomUUID();
  location.control({ sharing_id: sharing, enabled: true }, subject);
  location.update({ sharing_id: sharing, sequence: 1, fix: { latitude: 10, longitude: 20, accuracy: 5, measured_at: new Date().toISOString() } }, subject);
  const read = location.read();
  assert.ok(read.context);
  const pending = location.respond({ context_id: read.context!.context_id, disposition: 'announce', text: 'Synthetic fixture' });
  f.authority.revokeAll();
  await assert.rejects(pending);
  assert.equal(announced, 0);
  assert.equal(location.read().context, null);
  assert.equal(location.status().locationSharing, false);
  assert.throws(() => location.control({ sharing_id: randomUUID(), enabled: true }, subject));
  assert.throws(() => location.update({ sharing_id: sharing, sequence: 2 }, subject));
  const fresh = f.pair();
  const newSubject = f.authority.subject(fresh.token, f.phone)!;
  const renewed = f.authority.resume(fresh.resumeToken!, 'http://127.0.0.1:55003')!;
  assert.equal(f.authority.subject(renewed.token, 'http://127.0.0.1:55003'), newSubject);
  assert.doesNotThrow(() => location.control({ sharing_id: randomUUID(), enabled: true }, newSubject));
});

test('Mac saved-registration count excludes individual revocation receipts and keeps other registrations', async t => {
  const f = fixture(t), first = f.pair(), second = f.pair('http://127.0.0.1:55002');
  assert.equal((await pairingStatus(f.directory)).evenPairingCount, 2);
  assert.equal(f.authority.revokeRecovery(first.resumeToken!, f.phone), true);
  const status = await pairingStatus(f.directory);
  assert.equal(status.evenPairingKnown, true);
  assert.equal(status.evenPairingCount, 1);
  assert.equal(f.authority.authorized(second.token, 'http://127.0.0.1:55002'), true);
});
