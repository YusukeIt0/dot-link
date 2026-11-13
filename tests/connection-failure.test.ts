import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionFailure, connectionFailureCaption, connectionFailureHint, RelayResponseError } from '../src/connection-failure.ts';
import { RelaySession } from '../src/relay-session.ts';
import { RelaySettings } from '../src/relay-connection.ts';
import { InteractionStatus } from '../src/interaction-status.ts';
import { setLanguage, supportedLanguages } from '../src/i18n.ts';

test('only observed evidence selects a side; network errors and timeouts do not identify a VPN failure', () => {
  for (const error of [new TypeError('Failed to fetch'), new DOMException('Deadline', 'TimeoutError'), new Error('unknown')]) {
    assert.equal(connectionFailure(error, true), 'unreachable');
    assert.equal(connectionFailure(error, undefined), 'unreachable');
    assert.equal(connectionFailure(error, false), 'phone');
  }
  assert.equal(connectionFailure(new RelayResponseError('Unavailable'), true), 'relay');
  assert.equal(connectionFailure(new RelayResponseError('Unavailable'), false), 'relay');
});

function session(fetcher: typeof fetch, recover = false) {
  const map = new Map<string, string>();
  const settings = new RelaySettings(() => ({getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); }}));
  settings.save({origin: 'https://fixture.example-tail.ts.net', token: 't'.repeat(43), expiresAt: Date.now() + 3600000,
    ...(recover ? {resumeToken: 'r'.repeat(43)} : {})});
  return new RelaySession({settings, legacyToken: '', appOrigin: 'https://app.example', fetch: fetcher, rejected() {}, persistenceFailed() {}});
}

test('update and initial recovery HTTP errors reach the display classification without response contents', async () => {
  for (const recover of [false, true]) {
    for (const status of [403, 429, 500, 502, 503]) {
      const relay = session(async () => new Response('private upstream details', {status}), recover);
      await assert.rejects(relay.updates(undefined, new AbortController().signal), error => {
        assert.equal(connectionFailure(error, true), 'relay');
        assert.ok(!String(error).includes('private'));
        return true;
      });
      relay.stop();
    }
  }
});

test('failed fetch, unreadable response and automatic recovery keep their distinct outcomes', async () => {
  let mode = 0;
  const relay = session(async () => {
    if (mode === 0) throw new TypeError('Failed to fetch');
    if (mode === 1) return new Response('not json');
    return Response.json({revision: 'recovered'});
  });
  await assert.rejects(relay.updates(undefined, new AbortController().signal), error => connectionFailure(error, true) === 'unreachable');
  mode = 1;
  await assert.rejects(relay.updates(undefined, new AbortController().signal), error => connectionFailure(error, true) === 'relay');
  mode = 2;
  assert.deepEqual(await relay.updates(undefined, new AbortController().signal), {revision: 'recovered'});
  relay.stop();
});

test('all languages distinguish three captions, preserve active recording and clear failure captions on recovery', () => {
  try {
    for (const locale of supportedLanguages) {
      setLanguage(locale);
      const state = new InteractionStatus(); state.connection = 'offline';
      const labels = new Set<string>();
      for (const reason of ['phone', 'relay', 'unreachable'] as const) {
        state.connectionFailure = reason;
        assert.equal(state.caption(''), connectionFailureCaption(reason));
        labels.add(state.caption(''));
        assert.ok(connectionFailureHint(reason).length > 0);
      }
      assert.equal(labels.size, 3);
      state.phase = 'recording'; assert.ok(!labels.has(state.caption('')));
      state.phase = 'idle'; state.connection = 'online'; state.dotConnected = true;
      assert.equal(state.caption('Restored'), 'Restored');
    }
  } finally { setLanguage('ja'); }
});

test('re-pair HTTP rejection or unreadable response is not presented as an unreachable Mac', async () => {
  for (const response of [new Response('expired', {status: 400}), new Response('not json')]) {
    const relay = session(async () => response);
    const saved = relay.credentials;
    await assert.rejects(relay.pair({version: 1, origin: 'https://fixture.example-tail.ts.net', code: 'fixture', expiresAt: Date.now() + 120000}), error => {
      assert.equal(connectionFailure(error, true), 'relay'); return true;
    });
    assert.equal(relay.credentials, saved);
    relay.stop();
  }
});
