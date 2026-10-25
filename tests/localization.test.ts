import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseLanguage, setLanguage, t, message, translateLabel, seconds, speechLocale, supportedLanguages, languageName } from '../src/i18n.ts';
import { LanguagePreferences } from '../src/language-preferences.ts';
import { conversationText } from '../src/conversation-display.ts';
import { sttErrorMessage } from '../src/stt-errors.ts';
import { wrapHudText, HUD_BODY_TEXT_WIDTH } from '../src/hud-text.ts';
import { getTextWidth } from '@evenrealities/pretext';
import localeCases from './fixtures/locale-resolution.json' with { type: 'json' };
import { localeMetadata, type Language } from '../src/localization-catalogs.ts';

test('locale metadata controls selection, names and speech locale without changing legacy fallback', () => {
  assert.deepEqual(supportedLanguages, ['ja', 'en', 'ko', 'zh-Hant', 'zh-Hans', 'fr', 'de']);
  assert.equal(languageName('ko'), '한국어');
  for (const locale of ['ko', 'ko-KR', 'KO-kr', 'ko_KR']) assert.equal(chooseLanguage(locale, 'auto'), 'ko');
  for (const locale of ['ar', '', 'es-MX', 'kok-IN', 'korean']) assert.equal(chooseLanguage(locale), 'en');
  assert.equal(chooseLanguage('ko-KR', 'ja'), 'ja');
  assert.equal(chooseLanguage('ja-JP', 'ko'), 'ko');
  assert.equal(chooseLanguage('ko-KR', 'invalid'), 'ko');
  for (const locale of supportedLanguages) {
    setLanguage(locale); assert.equal(speechLocale(), localeMetadata[locale].speechLocale);
  }
});

test('script, region, explicit selection and fallback agree with native locale fixtures', () => {
  for (const {preferred, saved, expected} of localeCases) {
    assert.equal(chooseLanguage(preferred, saved), expected, `${preferred} / ${saved}`);
  }
});

test('every language persists through native restore without changing unrelated settings', async () => {
  const native = new Map<string, string>([['pairing', 'preserved'], ['wake', 'unchanged']]);
  const host = {getLocalStorage: async (key: string) => native.get(key) ?? '', setLocalStorage: async (key: string, value: string) => {native.set(key, value); return true;}};
  for (const locale of supportedLanguages) {
    const prefs = new LanguagePreferences(() => ({getItem: () => null, setItem() {}}));
    await prefs.attach(host); assert.equal(await prefs.save(locale), true);
    const fresh = new LanguagePreferences(() => ({getItem: () => null, setItem() {}}));
    await fresh.attach(host); assert.equal(fresh.value, locale);
  }
  assert.equal(native.get('pairing'), 'preserved');
  assert.equal(native.get('wake'), 'unchanged');
});

test('new languages render app labels without rewriting user text or literal parameters', () => {
  const text = '繁體 简体 français Deutsch {count} $&', reply = 'Reply / 回覆';
  for (const locale of ['zh-Hant', 'zh-Hans', 'fr', 'de'] as Language[]) {
    setLanguage(locale);
    assert.equal(conversationText({id: '1', text, reply, status: 'replied'}), `${t('even.you')}: ${text}\n\nDot: ${reply}`);
    assert.ok(t('even.host_processing', {host: '{angle} $&'}).includes('{angle} $&'));
    assert.notEqual(sttErrorMessage('STT_NO_TEXT'), message('even.no_words_were_recognized_please_speak_again', 'en'));
    const status = t('even.host_processing', {host: 'Mac'});
    setLanguage('en');
    assert.equal(translateLabel(status), 'Processing on Mac…');
  }
});

test('new scripts and accented text preserve content within the HUD width budget', () => {
  for (const text of ['繁體中文：連線已恢復，請繼續說話。', '简体中文：连接已恢复，请继续说话。', 'Connexion rétablie. Vous pouvez parler à nouveau. ', 'Verbindung wiederhergestellt. Ändern Sie Ihre Einstellungen. ']) {
    const original = text.repeat(12), wrapped = wrapHudText(original);
    assert.equal(wrapped.replaceAll('\n', ''), original);
    for (const line of wrapped.split('\n')) assert.ok(getTextWidth(line) <= HUD_BODY_TEXT_WIDTH);
  }
});

test('Korean preference survives native restore into a fresh origin without affecting another setting', async () => {
  const native = new Map<string, string>([['unrelated', 'preserved']]);
  const local = new Map<string, string>();
  const prefs = new LanguagePreferences(() => ({getItem: key => local.get(key) ?? null, setItem: (key, value) => { local.set(key, value); }}));
  const host = {getLocalStorage: async (key: string) => native.get(key) ?? '', setLocalStorage: async (key: string, value: string) => {native.set(key, value); return true;}};
  await prefs.attach(host); assert.equal(await prefs.save('ko'), true);
  const fresh = new LanguagePreferences(() => ({getItem: () => null, setItem() {}}));
  await fresh.attach(host); assert.equal(fresh.value, 'ko'); assert.equal(native.get('unrelated'), 'preserved');
});

test('dynamic labels change language while placeholder-like user values remain literal', () => {
  setLanguage('en');
  const status = t('even.host_processing', {host: 'Mac {angle} $&'});
  assert.equal(status, 'Processing on Mac {angle} $&…');
  setLanguage('ko');
  assert.equal(translateLabel(status), 'Mac {angle} $&에서 처리 중…');
  assert.equal(seconds(2), '2초');
  assert.equal(t('even.new_replies', {count: 3}), '새 답변 3개');
  assert.equal(translateLabel('arbitrary transcript'), 'arbitrary transcript');
  assert.equal(message('even.start_recording', 'en'), 'Start recording');
  assert.equal(message('even.start_recording', 'ja'), '録音を開始');
});

test('Korean app labels and safe STT errors do not translate conversation contents', () => {
  setLanguage('ko');
  const text = 'Hey dot, 日本語と 한국어 {count}', reply = 'Recording · 録音中 · 답변';
  assert.equal(conversationText({id: '1', text, reply, status: 'replied'}), `나: ${text}\n\nDot: ${reply}`);
  assert.equal(sttErrorMessage('STT_NO_TEXT'), '말씀을 인식하지 못했습니다. 다시 말씀해 주세요.');
  assert.equal(sttErrorMessage('untrusted provider output'), undefined);
  assert.equal(sttErrorMessage('constructor'), undefined);
});

test('Korean HUD wrapping preserves text and the existing width budget', () => {
  const original = '한국어로 대화하고 일본어와 English도 함께 사용합니다. '.repeat(12);
  const wrapped = wrapHudText(original);
  assert.equal(wrapped.replaceAll('\n', ''), original);
  for (const line of wrapped.split('\n')) assert.ok(getTextWidth(line) <= HUD_BODY_TEXT_WIDTH);
  // This checks measurement/wrapping only, not physical glyph rendering.
});
