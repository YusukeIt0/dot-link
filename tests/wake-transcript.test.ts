import assert from 'node:assert/strict';
import test from 'node:test';
import { wakeTranscript } from '../src/wake-transcript.ts';
import { setLanguage } from '../src/i18n.ts';

test('evidence-backed Korean cue cleanup is independent of display language', () => {
  for (const language of ['en', 'ja', 'ko'] as const) {
    setLanguage(language);
    assert.equal(wakeTranscript('헤이 닷 오늘 날씨를 알려줘'), '오늘 날씨를 알려줘');
    assert.equal(wakeTranscript('헤이, 닷! 오늘 날씨를 알려줘'), '오늘 날씨를 알려줘');
    assert.equal(wakeTranscript('헤이 닷'), '');
    assert.equal(wakeTranscript('Hey dot, 오늘 날씨를 알려줘'), '오늘 날씨를 알려줘');
  }
  setLanguage('ja');
});

test('ambiguous ASR output and ordinary Korean words are preserved', () => {
  for (const text of [
    'へいだっ', '헤이다 지금 몇 시야?', 'Hey.com 사이트를 열어줘',
    '헤이 닷컴 사이트를 열어 줘.', '헤이 닷새 동안', '헤이닷 오늘 날씨',
    '닷', '닷 오늘 날씨', '오늘 헤이 닷이라고 말했어', '“헤이 닷”이라고 말해',
  ]) assert.equal(wakeTranscript(text), text);
});

test('Korean default aliases never replace a captured custom wake name', () => {
  assert.equal(wakeTranscript('헤이 닷 오늘 날씨', 'Sakura'), '헤이 닷 오늘 날씨');
  assert.equal(wakeTranscript('헤이 사쿠라 오늘 날씨', 'Sakura'), '헤이 사쿠라 오늘 날씨');
  assert.equal(wakeTranscript('Hey Sakura, 오늘 날씨', 'Sakura'), '오늘 날씨');
  assert.equal(wakeTranscript('헤이 닷 오늘 날씨', 'invalid name'), '헤이 닷 오늘 날씨');
});

test('cleanup removes only one leading cue and preserves message contents', () => {
  assert.equal(wakeTranscript('헤이 닷 Hey dot, hello'), 'Hey dot, hello');
  assert.equal(wakeTranscript('Hey dot, 헤이 닷 오늘 날씨'), '헤이 닷 오늘 날씨');
  assert.equal(wakeTranscript('헤이 닷 질문에 dot product를 포함해'), '질문에 dot product를 포함해');
});
