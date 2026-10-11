import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sttSelection, saveSTTSelection, keychainSTTKey } from '../server/stt-settings.ts';
import { setLanguage } from '../src/i18n.ts';
import { sttErrorMessage } from '../src/stt-errors.ts';

test('selection persists without a credential, defaults only when absent, and can return to Whisper', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stt-settings-'));
  try {
    assert.equal(await sttSelection(directory), 'whisper');
    await saveSTTSelection(directory, 'soniox');
    assert.equal(await sttSelection(directory), 'soniox');
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'stt.json'), 'utf8')), {version: 1, provider: 'soniox'});
    assert.equal((await stat(join(directory, 'stt.json'))).mode & 0o777, 0o600);
    await assert.rejects(saveSTTSelection(directory, 'https://untrusted.test'), /STT_UNAVAILABLE/);
    assert.equal(await sttSelection(directory), 'soniox');
    await writeFile(join(directory, 'stt.json'), 'broken');
    await assert.rejects(sttSelection(directory), /STT_UNAVAILABLE/);
    await saveSTTSelection(directory, 'whisper');
    assert.equal(await sttSelection(directory), 'whisper');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('missing credential helper is a safe actionable failure', async () => {
  await assert.rejects(keychainSTTKey(undefined)(), /STT_KEY_REQUIRED/);
  await assert.rejects(keychainSTTKey('/nonexistent-stt-helper')(), /STT_KEY_REQUIRED/);
});

test('STT errors are translated from allowlisted codes only', () => {
  for (const language of ['ja', 'en'] as const) {
    setLanguage(language);
    for (const code of ['STT_BUSY','STT_KEY_REQUIRED','STT_AUTH','STT_QUOTA','STT_TIMEOUT','STT_UNAVAILABLE','STT_CANCELLED','STT_INVALID_RESPONSE','STT_NO_TEXT']) assert.ok(sttErrorMessage(code));
    assert.equal(sttErrorMessage('provider body with secret'), undefined);
    assert.equal(sttErrorMessage('toString'), undefined);
  }
  setLanguage('ja');
});
