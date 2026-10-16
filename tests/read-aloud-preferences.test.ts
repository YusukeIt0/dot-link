import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadAloudPreferences } from '../src/read-aloud-preferences.ts';
const KEY = 'dot-read-aloud-preference-v1';
const memory = () => {
  const data = new Map<string, string>();
  return {getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }};
};
const nativeStore = (disk: ReturnType<typeof memory>) => ({
  getLocalStorage: async (k: string) => disk.getItem(k) ?? '',
  setLocalStorage: async (k: string, v: string) => { disk.setItem(k, v); return true; },
});

test('first use and malformed values stay OFF', async () => {
  for (const raw of ['', 'invalid', '1']) {
    const disk = memory(); disk.setItem(KEY, raw);
    const prefs = new ReadAloudPreferences(() => disk);
    await prefs.attach(nativeStore(disk)); assert.equal(prefs.value, false);
  }
});
test('ON and OFF survive reopen and a changed WebView origin; native OFF overrides stale local ON', async () => {
  const disk = memory(), host = memory(), native = nativeStore(host);
  const first = new ReadAloudPreferences(() => disk); await first.attach(native);
  await first.save(true);
  assert.equal(new ReadAloudPreferences(() => disk).value, true);
  const reopened = new ReadAloudPreferences(memory); await reopened.attach(native);
  assert.equal(reopened.value, true); await reopened.save(false);
  const stale = new ReadAloudPreferences(() => disk); await stale.attach(native);
  assert.equal(stale.value, false); assert.equal(disk.getItem(KEY), 'false');
});
test('a choice before bridge attachment is persisted instead of overwritten', async () => {
  const host = memory(); host.setItem(KEY, 'true');
  const prefs = new ReadAloudPreferences(memory); await prefs.save(false);
  await prefs.attach(nativeStore(host)); assert.equal(prefs.value, false);
  assert.equal(host.getItem(KEY), 'false');
});
test('native timeout never overwrites a newer OFF with stale local ON', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const disk = memory(); disk.setItem(KEY, 'true');
  const writes: string[] = []; let resolve!: (value: string) => void;
  const prefs = new ReadAloudPreferences(() => disk);
  const attach = prefs.attach({getLocalStorage: () => new Promise(r => { resolve = r; }),
    setLocalStorage: async (_, value) => { writes.push(value); return true; }});
  t.mock.timers.tick(3001); await attach;
  assert.equal(prefs.value, false); assert.deepEqual(writes, []);
  resolve('false'); await Promise.resolve();
  assert.equal(prefs.value, false); assert.deepEqual(writes, []);
});
test('failed native read cannot activate stale local ON', async () => {
  const disk = memory(); disk.setItem(KEY, 'true');
  const prefs = new ReadAloudPreferences(() => disk);
  await prefs.attach({getLocalStorage: async () => { throw Error('unavailable'); },
    setLocalStorage: async () => { assert.fail('must not overwrite an unread setting'); }});
  assert.equal(prefs.value, false);
});
test('slow restore cannot replace a new choice and rapid toggles persist in order', async () => {
  let resolve!: (v: string) => void; const writes: string[] = [];
  const prefs = new ReadAloudPreferences(memory);
  const attach = prefs.attach({getLocalStorage: () => new Promise(r => { resolve = r; }),
    setLocalStorage: async (_, v) => { writes.push(v); return true; }});
  const on = prefs.save(true), off = prefs.save(false); resolve('true');
  await Promise.all([attach, on, off]); assert.equal(prefs.value, false);
  assert.deepEqual(writes, ['true', 'false']);
});
test('a failed write reports failure without blocking the current choice; subsequent writes recover', async () => {
  let failed = true;
  const prefs = new ReadAloudPreferences(() => { throw Error('unavailable'); });
  await prefs.attach({getLocalStorage: async () => { throw Error('unavailable'); },
    setLocalStorage: async () => { if (failed) throw Error('unavailable'); return true; }});
  assert.equal(await prefs.save(true), false); assert.equal(prefs.value, true);
  failed = false; assert.equal(await prefs.save(false), true); assert.equal(prefs.value, false);
});
