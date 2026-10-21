import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PairingAuthority, type RuntimeRecoveryResult } from '../server/pairing-authority.ts';
import { runtimeRecoveryRequest } from '../src/runtime-recovery.ts';

const host = 'https://mac.tailtest.ts.net';
const origin = (n: number) => `http://127.0.0.1:${55000 + n}`;
const id = (n: number) => `runtime-${String(n).padStart(16, '0')}`;
function resumed(result: RuntimeRecoveryResult) {
  assert.equal(result.kind, 'resumed');
  if (result.kind !== 'resumed') throw new Error('Expected credentials');
  return result;
}
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now();
  const authority = new PairingAuthority(root, () => now);
  const paired = authority.exchange(authority.issue(host).code, origin(1))!;
  assert.ok(paired.resumeToken);
  return { root, authority, paired, secret: paired.resumeToken, advance: (at: number) => { now = at; } };
}

test('retained runtimes cannot reclaim an acquired registration, including old recovery callers', t => {
  const s = fixture(t), a = s.authority;
  // Old persisted pairings continue to work until managed ownership is adopted.
  assert.ok(a.resume(s.secret, origin(1)));
  assert.deepEqual(a.recoverRuntime(s.secret, origin(1), { action: 'inspect' }), { kind: 'inspected', generation: 0 });
  const first = resumed(a.recoverRuntime(s.secret, origin(1), { action: 'claim', id: id(1), expectedGeneration: 0 }));
  const second = resumed(a.recoverRuntime(s.secret, origin(2), { action: 'claim', id: id(2), expectedGeneration: 1 }));
  const third = resumed(a.recoverRuntime(s.secret, origin(3), { action: 'claim', id: id(3), expectedGeneration: 2 }));
  for (let n = 0; n < 6; n++) {
    assert.deepEqual(a.recoverRuntime(s.secret, origin(1), { action: 'renew', id: id(1), generation: 1 }), { kind: 'superseded' });
    assert.deepEqual(a.recoverRuntime(s.secret, origin(2), { action: 'claim', id: id(2), expectedGeneration: 1 }), { kind: 'superseded' });
    assert.equal(a.resume(s.secret, origin(1)), undefined);
    assert.equal(a.authorized(third.credentials.token, origin(3)), true);
  }
  assert.equal(a.authorized(first.credentials.token, origin(1)), false);
  assert.equal(a.authorized(second.credentials.token, origin(2)), false);
  assert.equal(a.authorized(third.credentials.token, origin(2)), false);
  assert.equal(a.allowsOrigin(origin(1)), false);
  assert.equal(a.allowsOrigin(origin(3)), true);
  assert.equal(readdirSync(join(s.root, 'sessions')).length, 1);
});

test('lost replies retry idempotently across relay restart; a fresh runtime does not need saved session credentials', t => {
  const s = fixture(t);
  const claim = { action: 'claim', id: id(1), expectedGeneration: 0 } as const;
  const first = resumed(s.authority.recoverRuntime(s.secret, origin(1), claim));
  const file = join(s.root, 'sessions', readdirSync(join(s.root, 'sessions'))[0]);
  const writtenAt = statSync(file).mtimeMs;
  const restarted = new PairingAuthority(s.root);
  const retry = resumed(restarted.recoverRuntime(s.secret, origin(1), claim));
  assert.deepEqual(retry, first);
  const renewed = resumed(restarted.recoverRuntime(s.secret, origin(1), { action: 'renew', id: id(1), generation: 1 }));
  assert.deepEqual(renewed, first); assert.equal(statSync(file).mtimeMs, writtenAt);
  // Session persistence failed on the phone: its original recovery secret alone
  // can inspect and acquire a fresh runtime, without inheriting the old token.
  assert.deepEqual(restarted.recoverRuntime(s.secret, origin(2), { action: 'inspect' }), { kind: 'inspected', generation: 1 });
  const next = resumed(restarted.recoverRuntime(s.secret, origin(2), { action: 'claim', id: id(2), expectedGeneration: 1 }));
  assert.equal(next.credentials.expiresAt, s.paired.expiresAt);
  assert.equal(restarted.authorized(next.credentials.token, origin(2)), true);
  assert.deepEqual(restarted.recoverRuntime(s.secret, origin(1), claim), { kind: 'superseded' });
  for (const dir of ['sessions', 'recoveries']) for (const name of readdirSync(join(s.root, dir))) {
    const text = readFileSync(join(s.root, dir, name), 'utf8');
    assert.equal(text.includes(s.secret), false);
    assert.equal(text.includes(first.credentials.token), false);
    assert.equal(text.includes(next.credentials.token), false);
    assert.equal(statSync(join(s.root, dir, name)).mode & 0o777, 0o600);
  }
});

test('competing startup claims have one winner; failed persistence does not replace the active owner', t => {
  const s = fixture(t), a = s.authority;
  const first = resumed(a.recoverRuntime(s.secret, origin(1), { action: 'claim', id: id(1), expectedGeneration: 0 }));
  assert.deepEqual(a.recoverRuntime(s.secret, origin(2), { action: 'claim', id: id(2), expectedGeneration: 0 }), { kind: 'superseded' });
  const record = join(s.root, 'recoveries', readdirSync(join(s.root, 'recoveries'))[0]);
  mkdirSync(`${record}.next`);
  assert.throws(() => a.recoverRuntime(s.secret, origin(2), { action: 'claim', id: id(2), expectedGeneration: 1 }));
  assert.equal(a.authorized(first.credentials.token, origin(1)), true);
  assert.equal(readdirSync(join(s.root, 'sessions')).length, 1);
});

test('runtime handoff preserves separate devices, consent identity, expiry and revocation', t => {
  const s = fixture(t), a = s.authority;
  const subject = a.subject(s.paired.token, origin(1));
  const independent = a.exchange(a.issue(host).code, origin(4))!;
  const first = resumed(a.recoverRuntime(s.secret, origin(2), { action: 'claim', id: id(2), expectedGeneration: 0 }));
  assert.equal(a.subject(first.credentials.token, origin(2)), subject);
  assert.equal(a.authorizedSubject(subject!), true);
  assert.equal(a.authorized(independent.token, origin(4)), true);
  assert.deepEqual(a.recoverRuntime(s.secret, 'https://evil.example', { action: 'inspect' }), { kind: 'invalid' });
  assert.deepEqual(a.recoverRuntime(s.secret, origin(3), { action: 'renew', id: id(2), generation: 1 }), { kind: 'superseded' });
  assert.equal(a.revoke(first.credentials.token, origin(2)), true);
  assert.deepEqual(a.recoverRuntime(s.secret, origin(2), { action: 'inspect' }), { kind: 'invalid' });
  assert.equal(a.authorized(independent.token, origin(4)), true);
  const second = resumed(a.recoverRuntime(independent.resumeToken!, origin(4), { action: 'claim', id: id(4), expectedGeneration: 0 }));
  a.revokeAll();
  assert.equal(a.authorized(second.credentials.token, origin(4)), false);
  assert.deepEqual(a.recoverRuntime(independent.resumeToken!, origin(4), { action: 'renew', id: id(4), generation: 1 }), { kind: 'invalid' });
  const expiring = a.exchange(a.issue(host).code, origin(5))!;
  s.advance(expiring.expiresAt);
  assert.deepEqual(a.recoverRuntime(expiring.resumeToken!, origin(5), { action: 'inspect' }), { kind: 'invalid' });
});

test('runtime envelope accepts only the bounded explicit protocol', () => {
  for (const bad of [null, [], {}, { action: 'inspect', extra: true },
    { action: 'claim', id: id(1), expectedGeneration: -1 },
    { action: 'claim', id: id(1), expectedGeneration: 1.5 },
    { action: 'claim', id: id(1), expectedGeneration: Number.MAX_SAFE_INTEGER },
    { action: 'renew', id: id(1), generation: 0 },
    { action: 'renew', id: 'short', generation: 1 },
    { action: 'renew', id: id(1), generation: 1, extra: true }]) assert.equal(runtimeRecoveryRequest(bad), undefined);
});
