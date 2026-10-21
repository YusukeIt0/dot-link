import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { RelaySession } from '../src/relay-session.ts';
import { RelaySettings, type RelayCredentials } from '../src/relay-connection.ts';
import { RuntimeNative } from '../src/runtime-native.ts';
import { VoiceInput } from '../src/voice-input.ts';
import { ReadAloudPreferences } from '../src/read-aloud-preferences.ts';
const flush = async () => { for (let n = 0; n < 50; n++) await Promise.resolve(); };
const origin = (n: number) => `http://127.0.0.1:${57000 + n}`;
function fixture(t: {after(fn: () => void): void}) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-handoff-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  let authority = new PairingAuthority(root);
  const paired = authority.exchange(authority.issue('https://mac.example-tail.ts.net').code, origin(1))!;
  const original: RelayCredentials = {...paired, origin: 'https://mac.example-tail.ts.net', appOrigin: origin(1)};
  const native = new Map<string, string>();
  function client(n: number, input = original, source = origin(n)) {
    const local = new Map<string, string>(); let writesFail = false, retired = 0, persistenceFailures = 0;
    const rejected: string[] = [], requests: any[] = [];
    let intercept: ((url: string, init: RequestInit) => Promise<Response | undefined>) | undefined;
    let afterRecovery: ((action: string, response: Response) => Promise<Response>) | undefined;
    const settings = new RelaySettings(() => ({getItem: key => local.get(key) ?? null,
      setItem: (key, value) => { if (writesFail) throw new Error('Storage unavailable'); local.set(key, value); }, removeItem: key => local.delete(key)}));
    settings.save(input);
    const session = new RelaySession({settings, legacyToken: '', appOrigin: source,
      runtimeId: `runtime-${String(n).padStart(16, '0')}`, rejected: reason => rejected.push(reason),
      superseded: () => retired++, persistenceFailed: () => persistenceFailures++,
      fetch: (async (url: string, init: RequestInit) => {
        const envelope = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        requests.push({url, ...envelope});
        const overridden = await intercept?.(url, init); if (overridden) return overridden;
        if (url.endsWith('/api/pair/resume')) {
          const result = authority.recoverRuntime(envelope.resumeToken, source, envelope.runtime);
          const response = result.kind === 'invalid' ? Response.json({}, {status: 401})
            : result.kind === 'superseded' ? Response.json({code: 'runtime_superseded'}, {status: 409})
            : Response.json({protocol: 1, generation: result.generation, ...(result.kind === 'resumed' ? result.credentials : {})});
          return afterRecovery ? afterRecovery(envelope.runtime.action, response) : response;
        }
        const token = (init.headers as Record<string, string>).Authorization.slice(7);
        return authority.authorized(token, source) ? Response.json({revision: 'current'}) : Response.json({}, {status: 401});
      }) as typeof fetch});
    return {session, settings, local, requests, rejected, retired: () => retired, failures: () => persistenceFailures,
      failWrites: () => {writesFail = true;}, intercept: (fn: typeof intercept) => {intercept = fn;},
      afterRecovery: (fn: typeof afterRecovery) => {afterRecovery = fn;},
      attach: () => settings.attach({getLocalStorage: async key => native.get(key) ?? '', setLocalStorage: async (key, value) => {native.set(key, value); return true;}})};
  }
  return {client, original, native, restart: () => {authority = new PairingAuthority(root);}, authority: () => authority};
}

test('same-origin startup acquires ownership; three runtimes cannot renew each other out', async t => {
  const f = fixture(t), first = f.client(1);
  await first.session.ensureOrigin();
  assert.deepEqual(first.requests.map(r => r.runtime?.action), ['inspect', 'claim']);
  const second = f.client(2, first.session.credentials!, origin(1)); await second.session.ensureOrigin();
  const third = f.client(3, second.session.credentials!); await third.session.ensureOrigin();
  for (const stale of [first, second]) {
    const saved = [...stale.local];
    await assert.rejects(stale.session.updates(undefined, new AbortController().signal), /superseded/);
    assert.equal(stale.retired(), 1); assert.deepEqual(stale.rejected, []); assert.deepEqual([...stale.local], saved);
    const count = stale.requests.length;
    stale.session.restart();
    await assert.rejects(stale.session.ensureOrigin(), /Connection changed/);
    await assert.rejects(stale.session.location('/api/location/control', {enabled: false}), /superseded/);
    assert.equal(stale.requests.length, count, 'superseded runtimes never inspect or claim again');
  }
  for (let n = 0; n < 6; n++) await third.session.ensureOrigin(true);
  assert.equal(third.requests.filter(r => r.runtime?.action === 'claim').length, 1);
  assert.equal(f.authority().authorized(third.session.token, origin(3)), true);
});

test('lost claim replies retain the original CAS across restart and refuse a newer owner', async t => {
  const f = fixture(t), first = f.client(1);
  first.afterRecovery(async (action, response) => { if (action === 'claim') throw new Error('Reply lost'); return response; });
  await assert.rejects(first.session.ensureOrigin(), /Reply lost/);
  const claim = first.requests.find(r => r.runtime?.action === 'claim').runtime;
  f.restart(); first.session.restart(); first.afterRecovery(undefined);
  await first.session.ensureOrigin();
  assert.deepEqual(first.requests.filter(r => r.runtime?.action === 'claim').map(r => r.runtime), [claim, claim]);
  assert.equal(first.requests.filter(r => r.runtime?.action === 'inspect').length, 1);
  const second = f.client(2);
  second.afterRecovery(async (action, response) => { if (action === 'claim') throw new Error('Reply lost'); return response; });
  await assert.rejects(second.session.ensureOrigin(), /Reply lost/);
  const third = f.client(3); await third.session.ensureOrigin();
  second.afterRecovery(undefined);
  await assert.rejects(second.session.ensureOrigin(), /superseded/);
  assert.equal(second.requests.filter(r => r.runtime?.action === 'inspect').length, 1);
  assert.equal(f.authority().authorized(third.session.token, origin(3)), true);
});

test('failed persistence leaves current access usable and the original recovery secret can launch again', async t => {
  const f = fixture(t), first = f.client(1);
  first.failWrites(); await first.session.ensureOrigin(); await flush();
  assert.equal(first.failures(), 1);
  assert.equal(f.authority().authorized(first.session.token, origin(1)), true);
  const next = f.client(2, f.original); await next.session.ensureOrigin();
  assert.equal(f.authority().authorized(next.session.token, origin(2)), true);
  assert.equal(next.session.credentials!.resumeToken, f.original.resumeToken);
});

test('successful authentication recovery retries the update inside the same operation and revocation remains terminal', async t => {
  const f = fixture(t), c = f.client(1); await c.session.ensureOrigin();
  let fail = true;
  c.intercept(async url => { if (url.endsWith('/api/updates') && fail) { fail = false; return Response.json({}, {status: 401}); } });
  assert.deepEqual(await c.session.updates(undefined, new AbortController().signal), {revision: 'current'});
  assert.equal(c.requests.filter(r => r.url.endsWith('/api/updates')).length, 2);
  assert.equal(c.requests.at(-2).runtime.action, 'renew'); assert.deepEqual(c.rejected, []);
  f.authority().revoke(c.session.token, origin(1));
  await assert.rejects(c.session.updates(undefined, new AbortController().signal), /Recovery rejected/);
  assert.deepEqual(c.rejected, ['expired']); assert.equal(c.retired(), 0);
});

test('only the exact unsupported inspect response negotiates an old Mac; arbitrary errors never downgrade', async t => {
  const f = fixture(t);
  for (const [status, body] of [[400, {error: 'Storage error'}], [400, {error: 'Invalid pairing request', extra: true}], [503, {}], [200, {}]] as const) {
    const c = f.client(2); c.intercept(async () => Response.json(body, {status}));
    await assert.rejects(c.session.ensureOrigin(), /Recovery unavailable/);
    assert.equal(c.requests.length, 1); assert.equal(c.requests[0].runtime.action, 'inspect');
  }
  const c = f.client(2);
  c.intercept(async (url, init) => {
    if (!url.endsWith('/api/pair/resume')) return;
    const body = JSON.parse(String(init.body));
    if (body.runtime) return Response.json({error: 'Invalid pairing request'}, {status: 400});
    return Response.json(f.authority().resume(body.resumeToken, origin(2)));
  });
  await c.session.ensureOrigin();
  assert.equal(c.requests.length, 2); assert.equal(c.requests[1].runtime, undefined);
  assert.equal(f.authority().authorized(c.session.token, origin(2)), true);
});

test('retirement blocks queued preference/credential writes and late reads without cancelling replacement native resources', async () => {
  const gate = new RuntimeNative(), native = new Map<string, string>(), writes: string[] = [];
  let release!: () => void, first = true;
  const store = gate.storage({getLocalStorage: async key => native.get(key) ?? '', setLocalStorage: async (key, value) => {
    writes.push(value); if (first) {first = false; await new Promise<void>(resolve => {release = resolve;});}
    native.set(key, value); return true;
  }});
  const prefs = new ReadAloudPreferences(() => ({getItem: () => null, setItem() {}}));
  await prefs.attach(store);
  const one = prefs.save(true), two = prefs.save(false); await flush();
  gate.retire(); release(); await Promise.all([one, two]);
  assert.deepEqual(writes, ['true'], 'queued stale OFF never overwrites shared preferences');
  assert.equal(await store.setLocalStorage('pairing', 'null'), false);
  let nativeControls = 0; await gate.control(async () => {nativeControls++; return true;}); assert.equal(nativeControls, 0);
});

test('retiring during microphone start finishes local cleanup without issuing a late native close', async () => {
  const gate = new RuntimeNative(), controls: boolean[] = [];
  let release!: (ok: boolean) => void;
  const input = new VoiceInput({microphone: open => gate.control(() => {
    controls.push(open); return new Promise(resolve => {release = resolve;});
  }), loadWake: async () => {throw new Error('not used');}, onClip: () => assert.fail('retired clip'), onState() {}, onError() {}, onWakeState() {}});
  input.setContext(true, false, true);
  const start = input.start(); await flush(); assert.deepEqual(controls, [true]);
  gate.retire(); const dispose = input.dispose(); release(true);
  await Promise.all([start, dispose]); await flush();
  assert.deepEqual(controls, [true]); assert.equal(input.state, 'idle');
});

test('lost renew reply does not rotate ownership and a stale claim completion cannot overwrite a restarted session', async t => {
  const f = fixture(t), c = f.client(1); await c.session.ensureOrigin();
  const token = c.session.token;
  c.afterRecovery(async (action, response) => {if (action === 'renew') throw new Error('Reply lost'); return response;});
  await assert.rejects(c.session.ensureOrigin(true), /Reply lost/);
  c.afterRecovery(undefined); f.restart(); await c.session.ensureOrigin(true);
  assert.equal(c.session.token, token);
  const next = f.client(2); let release!: () => void;
  next.afterRecovery(async (action, response) => {if (action === 'claim') await new Promise<void>(resolve => {release = resolve;}); return response;});
  const first = next.session.ensureOrigin(); await flush();
  next.session.restart(); next.afterRecovery(undefined); await next.session.ensureOrigin();
  const current = next.session.token;
  release(); await assert.rejects(first, /Connection changed/);
  assert.equal(next.session.token, current);
  assert.equal(next.requests.filter(r => r.runtime?.action === 'inspect').length, 1);
});
