import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechPlayback} from '../src/speech-playback.ts';
import {G2Display} from '../src/g2-display.ts';
import {RelaySession} from '../src/relay-session.ts';
import {RelaySettings} from '../src/relay-connection.ts';
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function speechFixture() {
  let now = 0, allowed = true, failures = 0;
  const timers = new Map(), spoken = [];
  const synthesis = {speaking: false, pending: false, speak: speech => spoken.push(speech), cancel() {}};
  const playback = new SpeechPlayback({synthesis: () => synthesis, canSpeak: () => allowed,
    changed() {}, failed: () => failures++, now: () => now,
    schedule: (fn, ms) => { const key = {}; timers.set(key, {fn, at: now + ms}); return key; },
    cancelTimer: key => timers.delete(key)});
  const advance = ms => {
    const end = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = end;
  };
  return {playback, spoken, synthesis, timers, advance, allow: value => allowed = value, failures: () => failures};
}
test('read-aloud defers while recording and cancellation rejects late callbacks from old speech', () => {
  const s = speechFixture(), old = {}, current = {};
  s.allow(false); s.playback.speak(old); assert.equal(s.spoken.length, 0);
  s.allow(true); s.playback.flush(); assert.equal(s.spoken.length, 1);
  s.playback.cancel(); s.playback.speak(current); old.onend(); old.onerror();
  assert.equal(s.playback.active, true); assert.equal(s.failures(), 0);
  current.onend(); assert.equal(s.playback.active, false); assert.equal(s.playback.blocksInput, true);
  s.advance(650); assert.equal(s.playback.blocksInput, false);
  s.playback.stop(); assert.equal(s.timers.size, 0);
});
test('missing speech completion recovers only after native speech and its queue are idle', () => {
  const s = speechFixture(); s.playback.speak({}); s.synthesis.pending = true;
  s.advance(5000); assert.equal(s.playback.blocksInput, true);
  s.synthesis.pending = false; s.advance(500); assert.equal(s.playback.active, false);
  s.advance(650); assert.equal(s.playback.blocksInput, false); s.playback.stop();
});
test('session exit clears deferred speech and timers and ignores future playback', () => {
  const s = speechFixture(), speech = {}; s.playback.speak(speech);
  s.allow(false); s.playback.speak({}); s.playback.stop();
  speech.onerror(); s.allow(true); s.playback.flush(); s.playback.speak({});
  assert.equal(s.spoken.length, 1); assert.equal(s.timers.size, 0); assert.equal(s.failures(), 0);
});
function displayFixture() {
  let hidden = false, frame = {status: 'ready', conversation: 'old', help: 'hold', speech: 'off', receipt: '', newReplies: ''}, gate;
  const calls = [], physical = new Map(), timing = [];
  const display = new G2Display({ready: () => true, hidden: () => hidden, frame: () => frame,
    writer: () => async (id, name, content) => { calls.push([id, content]); if (gate) { const wait = gate; gate = undefined; await wait; } physical.set(id, content); return true; },
    failed: kind => assert.fail(kind), timing: (id, stage) => timing.push([id, stage]), report() {}});
  return {display, calls, physical, timing, hide: () => hidden = true, change: value => frame = {...frame, ...value},
    gate: () => { let release; gate = new Promise(resolve => release = resolve); return release; }};
}
test('a new frame supersedes an in-flight frame before its next container and reports only the winner', async () => {
  const s = displayFixture(), release = s.gate(); s.display.render('old'); await flush();
  s.change({conversation: 'new'}); s.display.render('new'); release(); await flush();
  assert.equal(s.physical.get(2), 'new'); assert.ok(!s.calls.some(([, text]) => text === 'old'));
  assert.deepEqual(s.timing.filter(([, stage]) => stage === 'g2_update_ack'), [['new', 'g2_update_ack']]);
});
test('standby blanking shares the display queue and unchanged status polls do not rewrite it', async () => {
  const s = displayFixture(); s.display.render(); await flush();
  const count = s.calls.length; for (let i = 0; i < 100; i++) s.display.refreshStatus(); await flush();
  assert.equal(s.calls.length, count); s.hide(); s.display.render(); await flush();
  assert.deepEqual([...s.physical.values()], Array(6).fill(' '));
  s.display.refreshStatus(); await flush(); assert.equal(s.calls.length, count + 6);
});
test('exit prevents queued frames from writing after an in-flight operation', async () => {
  const s = displayFixture(), release = s.gate(); s.display.render(); await flush();
  s.display.render(); s.display.stop(); release(); await flush(); assert.equal(s.calls.length, 1);
});
const credentials = {origin: 'https://test-mac.example-tail.ts.net', token: 'x'.repeat(43), resumeToken: 'r'.repeat(43), appOrigin: 'https://app.example', expiresAt: Date.now() + 3600000};
function relayFixture(fetcher, saved = credentials) {
  const map = new Map(), rejected = [];
  const settings = new RelaySettings(() => ({getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k)}));
  if (saved) settings.save(saved);
  const legacyFetch = (url, init) => {
    if (url.endsWith('/api/pair/resume') && JSON.parse(init.body).runtime?.action === 'inspect')
      return Promise.resolve(Response.json({error: 'Invalid pairing request'}, {status: 400}));
    return fetcher(url, init);
  };
  const session = new RelaySession({settings, legacyToken: '', appOrigin: 'https://app.example', fetch: legacyFetch,
    rejected: reason => rejected.push(reason), persistenceFailed() {}});
  return {session, settings, rejected};
}
test('old requests cannot succeed after a connection restart even if transport ignores abort', async () => {
  let resolve, signal;
  const s = relayFixture((_url, init) => {signal = init.signal; return new Promise(done => resolve = done);});
  const request = s.session.request('/api/messages'); await flush(); s.session.restart();
  assert.equal(signal.aborted, true); resolve(new Response('{}'));
  await assert.rejects(request, /Connection changed/);
});
test('recovery is shared within a session; an old recovery cannot overwrite a replacement session', async () => {
  const requests = [];
  const s = relayFixture(() => new Promise(resolve => requests.push(resolve)), {...credentials, appOrigin: 'https://old.example'});
  const first = s.session.ensureOrigin(), shared = s.session.ensureOrigin(); await flush(); assert.equal(requests.length, 1);
  s.session.restart(); s.session.use({...credentials, token: 'y'.repeat(43), appOrigin: 'https://other.example'});
  const next = s.session.ensureOrigin(); await flush(); assert.equal(requests.length, 2);
  requests[0](new Response(JSON.stringify(credentials)));
  await assert.rejects(first, /Connection changed/); await assert.rejects(shared, /Connection changed/);
  requests[1](new Response(JSON.stringify({...credentials, token: 'z'.repeat(43)}))); await next;
  assert.equal(s.session.token, 'z'.repeat(43));
});
test('an expired request resumes once and retries with the renewed token', async () => {
  const requests = [];
  const s = relayFixture(async (url, init) => {
    requests.push([url, init.headers.Authorization]);
    if (url.endsWith('/api/pair/resume')) return new Response(JSON.stringify({...credentials, token: 'n'.repeat(43)}));
    return requests.length === 1 ? new Response('', {status: 401}) : new Response('{}');
  });
  const response = await s.session.request('/api/messages'); assert.equal(response.ok, true);
  assert.equal(requests.length, 3); assert.equal(requests[2][1], `Bearer ${'n'.repeat(43)}`); assert.deepEqual(s.rejected, []);
});
test('location stop captures credentials and survives the ordinary session exit', async () => {
  let init, resolve;
  const s = relayFixture((_url, options) => {init = options; return new Promise(done => resolve = done);});
  const stop = s.session.location('/api/location/control', {enabled: false});
  s.session.stop(); s.session.forget(); assert.equal(init.signal.aborted, false);
  assert.equal(init.headers.Authorization, `Bearer ${credentials.token}`);
  resolve(new Response('{}')); await stop;
});

test('retirement fences each queued status container after an in-flight write', async () => {
  const s = displayFixture(), release = s.gate();
  s.display.refreshStatus(); await flush(); s.display.stop(); release(); await flush();
  assert.equal(s.calls.length, 1);
});
test('handoff drops local playback queues without cancelling replacement native speech', () => {
  const s = speechFixture(); let cancelled = 0; s.synthesis.cancel = () => cancelled++;
  const old = {}; s.playback.speak(old); s.playback.stop(false); old.onerror();
  assert.equal(cancelled, 0); assert.equal(s.timers.size, 0); assert.equal(s.failures(), 0);
});
