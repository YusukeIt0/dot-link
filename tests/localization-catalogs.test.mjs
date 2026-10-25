import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalization, validateCatalogs, validateNativeReferences } from '../scripts/localization.mjs';
import metadata from '../localization/locales.json' with { type: 'json' };
test('every registered language covers the catalog with matching named placeholders', async () => {
  const result = await checkLocalization();
  assert.ok(result.locales.includes('ko'));
  assert.ok(result.messages > 200);
});
test('catalog validation rejects missing, extra, empty and incompatible placeholders', () => {
  const fixture = () => Object.fromEntries(Object.keys(metadata).map(locale => [locale, {'even.test': 'Hello {name}'}]));
  assert.doesNotThrow(() => validateCatalogs(metadata, fixture()));
  for (const mutate of [
    data => { delete data.ko['even.test']; },
    data => { data.ko['even.extra'] = 'extra'; },
    data => { data.ko['even.test'] = ''; },
    data => { data.ko['even.test'] = '{other}'; },
    data => { data.ko['even.test'] = '{name} {name}'; },
    data => { data.ko['even.test'] = '{name} {bad-token}'; },
    data => { delete data.ko; },
  ]) {
    const data = fixture(); mutate(data); assert.throws(() => validateCatalogs(metadata, data));
  }
});

test('locale metadata rejects ambiguous matches and invalid script tags', () => {
  const catalogs = Object.fromEntries(Object.keys(metadata).map(locale => [locale, {'even.test': 'Text'}]));
  for (const mutate of [
    data => { data['zh-Hans'].matchLocales.push('ZH-TW'); },
    data => { data['zh-Hans'].matchLocales.push('zh-tw'); },
    data => { data.fr.matchLocales = ['de']; },
    data => { data.fr.matchLocales = []; },
    data => { data.fr.matchLocales = ['fr/FR']; },
    data => { data.fr.speechLocale = 'de-DE'; },
  ]) {
    const data = structuredClone(metadata); mutate(data);
    assert.throws(() => validateCatalogs(data, catalogs));
  }
});

test('native message validation includes conditional and dictionary-selected keys', () => {
  const source = 'tr(flag ? "mac.allowed" : "mac.denied"); let keys = ["wire": "common.unknown"]';
  const catalog = {'mac.allowed': 'Allowed', 'mac.denied': 'Denied', 'common.unknown': 'Unknown'};
  assert.doesNotThrow(() => validateNativeReferences(source, catalog));
  for (const key of Object.keys(catalog)) {
    const missing = {...catalog}; delete missing[key];
    assert.throws(() => validateNativeReferences(source, missing), /Unknown Swift message/);
  }
});
