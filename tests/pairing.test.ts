import test from 'node:test';
import assert from 'node:assert/strict';
import { Pairing } from '../src/pairing.ts';
const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
test('pairing survives a new WebView session and migrates old session settings', () => {
  const disk = memory(), oldSession = memory(), token = 'a'.repeat(43);
  oldSession.setItem('g2-device-token', token);
  assert.equal(new Pairing(() => disk, () => oldSession).read(), token);
  const reopened = new Pairing(() => disk, () => memory());
  assert.equal(reopened.read(), token);
  reopened.forget();
  assert.equal(new Pairing(() => disk, () => memory()).read(), '');
});
test('blocked WebView storage stays usable without retaining malformed credentials', () => {
  const unavailable = () => { throw new Error('SecurityError'); };
  const session = memory(); const pairing = new Pairing(unavailable, () => session);
  assert.equal(pairing.save('a'.repeat(43)), false);
  assert.equal(pairing.read(), 'a'.repeat(43));
  pairing.forget(); assert.equal(pairing.read(), '');
  assert.equal(pairing.save('invalid'), false); assert.equal(pairing.read(), '');
  assert.doesNotThrow(() => new Pairing(unavailable, unavailable).forget());
});
