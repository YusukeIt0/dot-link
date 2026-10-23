import test from 'node:test';
import assert from 'node:assert/strict';
import { DisconnectJournal, DisconnectRetry } from '../src/disconnect-journal.ts';
import { RelaySettings } from '../src/relay-connection.ts';
const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
const credentials = () => ({ origin: 'https://mac.tailtest.ts.net', token: 'a'.repeat(43), resumeToken: 'b'.repeat(43), expiresAt: Date.now() + 100000 });
const nativeStore = (disk = memory()) => ({ getLocalStorage: async (key: string) => disk.getItem(key) ?? '', setLocalStorage: async (key: string, value: string) => { disk.setItem(key, value); return true; } });

test('disconnect intent survives origin changes and ordinary or retained-runtime credential saves', async () => {
  const native = nativeStore(), oldWeb = memory(), nextWeb = memory();
  const first = credentials(), journal = new DisconnectJournal(() => oldWeb), settings = new RelaySettings(() => oldWeb);
  assert.equal(await journal.attach(native), true);
  await settings.attach(native); settings.save(first); await settings.nativeSaved();
  journal.add(first); settings.forget(false);
  assert.equal(await journal.persist(), true);
  // A retained runtime writes the active pairing record after disconnect.
  settings.save(first); await settings.nativeSaved();
  const reopened = new DisconnectJournal(() => nextWeb);
  assert.equal(await reopened.attach(native), true);
  assert.equal(reopened.blocks(first), true);
  const other = { ...first, token: 'c'.repeat(43), resumeToken: 'd'.repeat(43) };
  assert.equal(reopened.blocks(other), false, 'explicitly paired new identity remains usable');
  assert.equal(reopened.pending.length, 1);
});

test('offline retries retain proof, send only revocation and clear it only after acknowledgment', async t => {
  const disk = memory(), native = nativeStore(), journal = new DisconnectJournal(() => disk);
  await journal.attach(native); journal.add(credentials());
  const paths: string[] = [], states: unknown[] = []; let online = false, cleared = 0;
  const retry = new DisconnectRetry({ journal, durable: () => { cleared++; }, changed: state => states.push(state),
    fetch: async (url, init) => {
      paths.push(String(url));
      assert.deepEqual(JSON.parse(String(init?.body)), { resumeToken: credentials().resumeToken });
      if (!online) throw new Error('offline');
      return new Response(null, { status: 204 });
    } });
  t.after(() => retry.stop());
  await retry.run();
  assert.equal(journal.pending.length, 1);
  assert.deepEqual(states.at(-1), { pending: 1, durable: true });
  online = true; await retry.run();
  assert.equal(journal.pending.length, 0);
  assert.equal(cleared, 2);
  assert.ok(paths.every(path => path.endsWith('/api/pair/revoke')));
  const reopened = new DisconnectJournal(() => memory()); await reopened.attach(native);
  assert.equal(reopened.pending.length, 0);
});

test('native storage errors stay visible and never authorize clearing the old native credential before intent is durable', async t => {
  const journal = new DisconnectJournal(() => memory());
  await journal.attach({ getLocalStorage: async () => '', setLocalStorage: async () => false });
  journal.add(credentials());
  let clears = 0; const states: unknown[] = [];
  const retry = new DisconnectRetry({ journal, durable: () => { clears++; }, changed: state => states.push(state), fetch: async () => { throw new Error('offline'); } });
  t.after(() => retry.stop());
  await retry.run();
  assert.equal(clears, 0);
  assert.deepEqual(states.at(-1), { pending: 1, durable: false });
  assert.equal(journal.pending.length, 1);
});

test('an unreadable or corrupt native journal never permits connection restoration', async () => {
  const journal = new DisconnectJournal(() => memory());
  assert.equal(await journal.attach({ getLocalStorage: async () => { throw new Error('read failed'); }, setLocalStorage: async () => true }), false);
  assert.equal(await journal.attach({ getLocalStorage: async () => '{broken', setLocalStorage: async () => true }), false);
  assert.equal(await journal.attach({ getLocalStorage: async () => '{"version":1,"pending":[{"token":"bad"}]}', setLocalStorage: async () => true }), false);
});

test('exit during response wait preserves proof; another launch can retry a lost acknowledgment', async () => {
  const journal = new DisconnectJournal(() => memory()); await journal.attach(nativeStore()); journal.add(credentials());
  let reply!: (response: Response) => void, entered!: () => void;
  const sent = new Promise<void>(resolve => { entered = resolve; });
  const retry = new DisconnectRetry({ journal, durable: () => {}, changed: () => {}, fetch: () => { entered(); return new Promise<Response>(resolve => { reply = resolve; }); } });
  const flight = retry.run(); await sent; retry.stop(); reply(new Response(null, { status: 204 })); await flight;
  assert.equal(journal.pending.length, 1);
});
