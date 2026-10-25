import test from 'node:test';
import assert from 'node:assert/strict';
import { LanguagePreferences } from '../src/language-preferences.ts';
import { chooseLanguage } from '../src/i18n.ts';
const memory = () => {
  const data = new Map<string, string>();
  return {getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => {data.set(k, v);}};
};
test('initial locale and unsupported locales use the supported-language fallback', () => {
  for (const [input, expected] of [['ja-JP','ja'], ['JA-jp','ja'], ['en-GB','en'], ['zh-CN','zh-Hans'], ['fr','fr'], ['ar','en'], ['','en']]) {
    const prefs = new LanguagePreferences(memory);
    assert.equal(prefs.value, 'auto'); assert.equal(chooseLanguage(input, prefs.value), expected);
  }
});
test('manual and automatic preferences survive a changed WebView origin; legacy choice migrates', async () => {
  const host = memory(), disk = memory(); disk.setItem('dot-language', 'ja');
  const native = {getLocalStorage: async (k: string) => host.getItem(k) ?? '', setLocalStorage: async (k: string, v: string) => {host.setItem(k,v); return true;}};
  const old = new LanguagePreferences(() => disk); await old.attach(native);
  await old.save('en');
  const fresh = new LanguagePreferences(memory); await fresh.attach(native); assert.equal(fresh.value, 'en');
  await fresh.save('auto');
  const stale = new LanguagePreferences(() => disk); await stale.attach(native); assert.equal(stale.value, 'auto');
});
test('slow native restore cannot overwrite a new choice and writes retain selection order', async () => {
  let resolve!: (v: string) => void; const values: string[] = [];
  const prefs = new LanguagePreferences(memory);
  const attach = prefs.attach({getLocalStorage: () => new Promise(r => {resolve = r;}), setLocalStorage: async (_, v) => {values.push(v); return true;}});
  const first = prefs.save('en'), second = prefs.save('auto'); resolve('ja');
  await Promise.all([attach, first, second]); assert.equal(prefs.value, 'auto'); assert.deepEqual(values, ['en','auto']);
});
test('unavailable storage does not prevent switching but reports that saving failed', async () => {
  const prefs = new LanguagePreferences(() => {throw Error('unavailable');});
  await prefs.attach({getLocalStorage: async () => {throw Error('unavailable');}, setLocalStorage: async () => false});
  assert.equal(await prefs.save('en'), false); assert.equal(prefs.value, 'en');
});
