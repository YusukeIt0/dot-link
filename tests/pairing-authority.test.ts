import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { appOrigin, parseInvite, relayOrigin } from '../src/relay-origin.ts';

test('pairing expires, binds the app origin, consumes once, persists only hashes and can be revoked', t => {
  const root = mkdtempSync(join(tmpdir(), 'g2-pairing-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now(); const authority = new PairingAuthority(root, () => now);
  const origin = 'https://package.example';
  const invite = authority.issue('https://mac.tailtest.ts.net', origin);
  assert.equal(authority.allowsOrigin(origin), true);
  assert.equal(authority.allowsOrigin('https://evil.example'), false);
  assert.equal(parseInvite(JSON.stringify(invite), now).origin, 'https://mac.tailtest.ts.net');
  assert.equal(authority.exchange(invite.code, 'https://evil.example'), undefined);
  const result = authority.exchange(invite.code, origin)!; assert.ok(result);
  assert.equal(authority.exchange(invite.code, origin), undefined);
  assert.equal(authority.authorized(result.token, origin), true);
  assert.equal(authority.authorized(result.token, 'null'), false);
  assert.equal(new PairingAuthority(root, () => now).authorized(result.token, origin), true);
  for (const filename of readdirSync(join(root, 'sessions'))) {
    assert.equal(readFileSync(join(root, 'sessions', filename), 'utf8').includes(result.token), false);
    assert.equal(statSync(join(root, 'sessions', filename)).mode & 0o777, 0o600);
  }
  assert.equal(authority.revoke(result.token, 'https://evil.example'), false);
  assert.equal(authority.revoke(result.token, origin), true);
  assert.equal(authority.authorized(result.token, origin), false);
  assert.equal(authority.allowsOrigin(origin), false);
  const expired = authority.issue('https://mac.tailtest.ts.net', origin); now += 120001;
  assert.equal(authority.exchange(expired.code, origin), undefined);
  assert.throws(() => parseInvite(JSON.stringify(expired), now));
  const fresh = authority.issue('https://mac.tailtest.ts.net', origin);
  const session = authority.exchange(fresh.code, origin)!;
  now = session.expiresAt; assert.equal(authority.authorized(session.token, origin), false);
  authority.revokeAll(); assert.deepEqual(readdirSync(join(root, 'sessions')), []);
});

test('relay input cannot redirect pairing credentials to URLs, LAN services or arbitrary Internet hosts', () => {
  for (const value of ['http://mac.tailtest.ts.net', 'https://mac.tailtest.ts.net.evil.com', 'https://evil.com',
    'https://127.0.0.1', 'https://100.64.0.1', 'https://mac.tailtest.ts.net:8443',
    'https://user@mac.tailtest.ts.net', 'https://mac.tailtest.ts.net/route', 'https://mac.tailtest.ts.net?x=1',
    'https://mac.tailtest.ts.net#secret', 'https://mac.tailtest.ts.net\\@evil.com']) {
    assert.throws(() => relayOrigin(value), value);
  }
  assert.equal(relayOrigin('https://mac.tailtest.ts.net'), 'https://mac.tailtest.ts.net');
});

test('installed iOS loopback origin is explicitly paired and remains bound to its exact port', t => {
  const root = mkdtempSync(join(tmpdir(), 'g2-loopback-')); t.after(() => rmSync(root, {recursive:true,force:true}));
  const authority = new PairingAuthority(root), source = 'http://127.0.0.1:54965';
  assert.equal(appOrigin(source), source);
  for (const invalid of ['http://localhost:54965','http://192.168.1.2:54965','http://evil.example:54965',
    'http://127.0.0.1','http://127.0.0.1:80','http://127.0.0.1:54965/',
    'http://user@127.0.0.1:54965','http://127.0.0.1:54965?x=1']) assert.throws(()=>appOrigin(invalid));
  assert.throws(()=>relayOrigin(source));
  assert.equal(authority.allowsOrigin(source),false);
  const invite = authority.issue('https://mac.tailtest.ts.net',source);
  assert.equal(authority.allowsOrigin(source),true);
  assert.equal(authority.allowsOrigin('http://127.0.0.1:54966'),false);
  assert.equal(authority.exchange(invite.code,'http://127.0.0.1:54966'),undefined);
  const session=authority.exchange(invite.code,source)!;
  assert.ok(session);
  assert.equal(authority.authorized(session.token,'http://127.0.0.1:54966'),false);
  assert.equal(authority.authorized(session.token,source),true);
});

test('Mac can issue first; packaged source binds only after possession of the code', t => {
  const root = mkdtempSync(join(tmpdir(), 'g2-first-mac-')); t.after(() => rmSync(root, {recursive:true,force:true}));
  const authority = new PairingAuthority(root), source = 'http://127.0.0.1:55001';
  assert.equal(authority.allowsPairingOrigin(source),false);
  const invite = authority.issue('https://mac.tailtest.ts.net');
  assert.equal(authority.allowsPairingOrigin(source),true);
  assert.equal(authority.allowsOrigin(source),false);
  assert.equal(authority.allowsPairingOrigin('https://evil.example'),false);
  assert.equal(authority.allowsPairingOrigin('null'),false);
  assert.equal(authority.exchange(invite.code,'https://evil.example'),undefined);
  const session=authority.exchange(invite.code,source)!;
  assert.ok(session);
  assert.equal(authority.exchange(invite.code,source),undefined);
  assert.equal(authority.authorized(session.token,source),true);
  assert.equal(authority.authorized(session.token,'http://127.0.0.1:55002'),false);
  assert.equal(authority.allowsOrigin('http://127.0.0.1:55002'),false);
});

test('update recovery changes the exact port, invalidates old tokens, retries lost replies and respects revocation/expiry', t => {
  const root = mkdtempSync(join(tmpdir(), 'g2-recovery-')); t.after(() => rmSync(root, {recursive:true,force:true}));
  let now = Date.now(); const authority = new PairingAuthority(root, () => now);
  const oldOrigin = 'http://127.0.0.1:55895', newOrigin = 'http://127.0.0.1:57157';
  const paired = authority.exchange(authority.issue('https://mac.tailtest.ts.net').code, oldOrigin)!;
  assert.ok(paired.resumeToken);
  assert.equal(authority.resume(paired.token, newOrigin), undefined, 'data token cannot recover');
  assert.equal(authority.resume('x'.repeat(43), newOrigin), undefined);
  assert.equal(authority.resume(paired.resumeToken!, 'https://evil.example'), undefined);
  assert.equal(authority.resume(paired.resumeToken!, 'null'), undefined);
  assert.equal(authority.authorized(paired.resumeToken!, oldOrigin), false, 'recovery secret cannot read data');
  const changed = authority.resume(paired.resumeToken!, newOrigin)!;
  assert.equal(changed.expiresAt, paired.expiresAt);
  assert.equal(authority.authorized(paired.token, oldOrigin), false);
  assert.equal(authority.authorized(changed.token, oldOrigin), false);
  assert.equal(authority.authorized(changed.token, newOrigin), true);
  assert.equal(authority.allowsOrigin(oldOrigin), false);
  const retry = new PairingAuthority(root, () => now).resume(paired.resumeToken!, newOrigin)!;
  assert.equal(authority.authorized(changed.token, newOrigin), false);
  assert.equal(authority.authorized(retry.token, newOrigin), true);
  for (const dir of ['sessions', 'recoveries']) for (const name of readdirSync(join(root, dir))) {
    const text = readFileSync(join(root, dir, name), 'utf8');
    assert.equal(text.includes(paired.resumeToken!), false); assert.equal(text.includes(retry.token), false);
  }
  assert.equal(authority.revoke(retry.token, newOrigin), true);
  assert.equal(authority.resume(paired.resumeToken!, oldOrigin), undefined);
  const another = authority.exchange(authority.issue('https://mac.tailtest.ts.net').code, oldOrigin)!;
  now = another.expiresAt;
  assert.equal(authority.resume(another.resumeToken!, newOrigin), undefined);
  authority.revokeAll(); assert.deepEqual(readdirSync(join(root, 'recoveries')), []);
});
