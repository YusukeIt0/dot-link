import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretInput } from '../scripts/secret-input.mjs';

const fakeKey = 'sk-FAKE_TEST_VALUE_NOT_A_CREDENTIAL_1234567890';

test('bracketed terminal paste is decoded even when delimiters arrive in separate chunks', () => {
  const decoder = new SecretInput();
  for (const chunk of ['\u001b[20', '0~  ', fakeKey, '\n', '\u001b[20', '1~']) assert.equal(decoder.push(chunk), undefined);
  assert.deepEqual(decoder.push('\r'), { value: fakeKey });
  assert.equal(decoder.value, '');
});

test('ordinary paste, backspace and cancellation work without a displayed secret', () => {
  const decoder = new SecretInput();
  assert.deepEqual(decoder.push(fakeKey + 'X\u007f\r'), { value: fakeKey });
  const cancelled = new SecretInput();
  assert.deepEqual(cancelled.push(fakeKey + '\u0003'), { cancelled: true });
  assert.equal(cancelled.value, '');
});

test('masked keys, tracking IDs, multiline content, and oversized paste are rejected without echoing input', () => {
  for (const value of ['sk-...abcd', 'key_tracking_id', fakeKey + '\nother-text', fakeKey + 'x'.repeat(5000)]) {
    const decoder = new SecretInput();
    decoder.push('\u001b[200~' + value + '\u001b[201~');
    const result = decoder.push('\r');
    assert.equal(typeof result.error, 'string');
    assert.equal(result.error.includes(value), false);
    assert.equal(result.value, undefined);
  }
});
