import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import * as sdk from '@evenrealities/even_hub_sdk';

const mainUrl = new URL('../src/main.ts', import.meta.url);
const source = await readFile(mainUrl, 'utf8');
const dependencies = { ...sdk };
for (const match of source.matchAll(/import\s+\{[^}]*\}\s+from\s+'(\.\/[^']+)'/g)) {
  Object.assign(dependencies, await import(new URL(match[1], mainUrl).href));
}
const script = stripTypeScriptTypes(source
  .replace(/import\s+[\s\S]*?from\s+'[^']+';\n/g, '')
  .replace(/import '\.\/style.css';/, '')
  .replace('import.meta.env.VITE_APP_VERSION', "'test'")
  .replace('import.meta.env.VITE_EXIT_DIAGNOSTICS', 'exitDiagnosticsFlag'));
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

async function launch(options = {}) {
  let now = 0, timerId = 0, receiver;
  const epoch = Date.now();
  const timers = new Map(); const elements = new Map(); const listeners = new Map();
  const calls = []; const networkCalls = []; const requests = []; const physical = new Map();
  const saved = new Map(options.nativePairing ? [] : [['g2-device-token', 'x'.repeat(43)]]);
  const nativeSaved = new Map(options.nativePairing ? [['dot-relay-native-v1', JSON.stringify(options.nativePairing)]] : []);
  for (const [key, value] of options.nativeState ?? []) nativeSaved.set(key, value);
  if (options.savedLanguage) saved.set('dot-language', options.savedLanguage);
  if (options.nativeLanguage) nativeSaved.set('dot-language-preference-v1', options.nativeLanguage);
  if (options.nativeReadAloud !== undefined) nativeSaved.set('dot-read-aloud-preference-v1', String(options.nativeReadAloud));
  if (options.localReadAloud !== undefined) saved.set('dot-read-aloud-preference-v1', String(options.localReadAloud));
  let resumeAttempts = 0;
  let writeGate;
  const schedule = (callback, ms, repeat = false) => {
    const id = ++timerId; timers.set(id, { callback, at: now + ms, ms, repeat }); return id;
  };
  const clock = {now: () => now, schedule, cancel: id => timers.delete(id)};
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent: '', value: '', dataset: {}, checked: false, disabled: false,
      before() {}, after() {}, attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.attributes.delete(name); }, focus() {}, close() {}, pause() {}, showModal() {},
      listeners: new Map(), addEventListener(type, callback) { this.listeners.set(type, callback); },
      dispatchEvent(event) { this.listeners.get(event.type)?.(event); },
      click() { if (!this.disabled) return this.onclick?.(); }});
    return elements.get(id);
  };
  const listen = (name, callback) => { listeners.set(name, callback); };
  const bridge = {
    async createStartUpPageContainer(page) { calls.push(['create']); for (const c of page.textObject) physical.set(c.containerID, c.content); return 0; },
    async textContainerUpgrade(update) {
      calls.push(['text', update.containerID, update.content]);
      if (writeGate) { const gate = writeGate; writeGate = undefined; await gate; }
      physical.set(update.containerID, update.content); return true;
    },
    onEvenHubEvent(callback) { receiver = callback; },
    async audioControl(open) { calls.push(['mic', open]); return options.microphone?.(open) ?? true; },
    async imuControl(open) { calls.push(['imu', open]); return true; },
    async shutDownPageContainer(mode) { calls.push(['exit', mode]); return true; },
    async getLocalStorage(k) { return options.nativeRead?.(k) ?? nativeSaved.get(k) ?? ''; },
    async setLocalStorage(k, v) { const result = await (options.nativeWrite?.(k, v) ?? true); if (result) nativeSaved.set(k, v); return result; },
    onAppLocationChanged() { return () => {}; },
    async startAppLocationUpdates() { calls.push(['location-start']); return true; },
    async stopAppLocationUpdates() { calls.push(['location-stop']); return true; },
    async getAppLocation() { return {latitude: 10, longitude: 20, accuracy: 5, timestamp: epoch + now}; },
  };
  const staticLabel = element('static-test-label'); staticLabel.textContent = '表示設定'; staticLabel.dataset.en = 'Display settings';
  const local = {getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k)};
  const context = vm.createContext({ ...dependencies,
    LocationSharing: class extends dependencies.LocationSharing { constructor(options) { super({...options, now: () => epoch + now, automatic: false}); } },
    loadWakeDetector: options.loadWake ?? dependencies.loadWakeDetector,
    exitDiagnosticsFlag: options.exitDiagnostics ? '1' : '0',
    // This harness models G2 lifecycle, not DOM geometry; viewport behavior has its own tests.
    installKeyboardViewport: () => () => {},
    installTranscriptSize: () => () => {},
    InteractionStatus: class extends dependencies.InteractionStatus { constructor() { super(() => now); } },
    Date: class extends Date { static now() { return epoch + now; } },
    DisplayStandby: class extends dependencies.DisplayStandby { constructor(p, changed) { super(p, changed, clock); } },
    waitForEvenAppBridge: async () => bridge,
    document: {documentElement: {}, body: {dataset: {}}, hidden: false, getElementById: element,
      querySelector: element, querySelectorAll: selector => selector === '[data-en]' ? [staticLabel] : selector === 'textarea' ? [element('transcript'), element('pair-code')] : [...elements.values()], createComment: element, addEventListener: listen},
    window: {addEventListener: listen, speechSynthesis: {cancel() {}, speak(speech) { calls.push(['speech', speech.text]); }}},
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    navigator: {language: options.language ?? 'ja', userAgent: options.userAgent ?? 'iPhone', maxTouchPoints: 5},
    localStorage: local, sessionStorage: local, location: {origin: options.nativePairing ? 'http://127.0.0.1:57157' : 'https://test.invalid', hash: '', pathname: '/', search: ''},
    history: {replaceState() {}}, performance: {now: () => now}, crypto, console, URLSearchParams, AbortController, AbortSignal, Uint8Array, Blob, TextEncoder,
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
    fetch: (url, init) => {
      networkCalls.push(String(url));
      const custom = options.request?.(String(url), init);
      if (custom !== undefined) return custom;
      if (String(url).includes('/api/location/')) {
        calls.push(['location-api', String(url), JSON.parse(init.body)]);
        return Promise.resolve({status: 200, ok: true, json: async () => ({locationSharing: true, locationFresh: true})});
      }
      if (options.typedInput && String(url).endsWith('/api/utterances')) {
        const value = JSON.parse(init.body);
        return Promise.resolve({status: 200, ok: true, json: async () => ({...value, status: 'accepted', createdAt:new Date(epoch + now).toISOString()})});
      }
      if (String(url).endsWith('/api/pair/resume')) {
        if (JSON.parse(init.body).runtime?.action === 'inspect') return Promise.resolve({status: 400, ok: false, json: async () => ({error: 'Invalid pairing request'})});
        resumeAttempts++;
        assert.equal(JSON.parse(init.body).resumeToken, options.nativePairing.resumeToken);
        calls.push(['resume']);
        if (options.failResumeOnce && resumeAttempts === 1) return Promise.reject(new Error('Temporary offline'));
        return Promise.resolve({status:200,ok:true,json:async()=>({...options.nativePairing,token:'n'.repeat(43)})});
      }
      if (String(url).endsWith('/api/timings')) return Promise.resolve({status: 204, ok: true});
      assert.equal(url, options.nativePairing ? `${options.nativePairing.origin}/api/updates` : '/api/updates', 'fixture must never access another API');
      if (options.nativePairing) assert.equal(init.headers.Authorization, `Bearer ${'n'.repeat(43)}`, 'only resumed token reaches data API');
      return new Promise((resolve, reject) => requests.push(Object.assign(resolve, {reject})));
    },
  });
  vm.runInContext(script, context); await flush();
  assert.equal(element('g2-diagnostic').textContent, 'G2_READY');
  const snapshot = (messages = []) => ({revision: 'same', status: {subscribed: true, deviceName: 'Test Mac', sttProvider: options.provider}, messages});
  const deliver = async value => {
    assert.ok(requests.length, 'receiver must still be waiting');
    requests.shift()({ok: true, status: 200, json: async () => structuredClone(value)}); await flush();
  };
  if (!options.failResumeOnce && !options.skipInitialUpdate) await deliver(snapshot(options.initialMessages ?? []));
  const advance = async ms => {
    const end = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      if (next[1].repeat) next[1].at += next[1].ms; else timers.delete(next[0]);
      next[1].callback(); await flush();
    }
    now = end; await flush();
  };
  return {now: () => epoch + now, calls, networkCalls, physical, element, saved, nativeSaved, timers, snapshot, deliver, advance, context,
    browserEvent: async name => {listeners.get(name)?.({persisted: false}); await flush();},
    failUpdate: async () => {assert.ok(requests.length); requests.shift().reject(new Error('Network unavailable')); await flush();},
    emit: async event => {receiver(event); await flush();},
    evaluate: async code => {vm.runInContext(code, context); await flush();},
    gate: () => {let release; writeGate = new Promise(resolve => {release = resolve;}); return release;},
    close: async () => {vm.runInContext('stopSession()', context); await flush();},
    locale: async value => {context.navigator.language = value; listeners.get('languagechange')?.(); await flush();},
    hidden: () => vm.runInContext('standby.hidden', context),
  };
}

const doubleTap = {textEvent: {eventType: sdk.OsEventTypeList.DOUBLE_CLICK_EVENT}};
const singleTap = {textEvent: {}}; // zero enum omitted by the native host
const proactive = id => ({id, text: '', reply: `Synthetic message ${id}`, status: 'replied', kind: 'proactive'});

for (const language of ['en', 'ja']) {
 for (const autoSend of [false, true]) {
  test(`phone record icon stops in place and preserves transcription/auto-send (${language}, auto=${autoSend})`, {timeout: 5000}, async t => {
   let finishTranscript, sent;
   const sentRequest = new Promise(resolve => { sent = resolve; });
   const app = await launch({language, typedInput: true, request: url => {
    if (url.endsWith('/api/transcribe')) return new Promise(resolve => { finishTranscript = resolve; });
    if (url.endsWith('/api/utterances')) sent();
   }}); t.after(app.close);
   const record = app.element('record'), discard = app.element('discard');
   app.element('auto-send').checked = autoSend;
   assert.equal(record.getAttribute('aria-label'), language === 'ja' ? '録音を開始' : 'Start recording');
   assert.equal(record.dataset.recordState, 'idle');
   assert.equal(app.element('transcript').placeholder, language === 'ja' ? 'Dotにメッセージ…' : 'Message Dot…');
   await record.click(); await flush();
   assert.equal(record.dataset.recordState, 'recording');
   assert.equal(record.getAttribute('aria-label'), language === 'ja' ? '録音を停止' : 'Stop recording');
   assert.equal(discard.disabled, false);
   assert.equal(discard.getAttribute('aria-label'), language === 'ja' ? '録音を破棄' : 'Discard recording');
   await app.emit({audioEvent: {audioPcm: new Uint8Array(3200)}});
   await record.click(); await flush();
   assert.equal(record.dataset.recordState, 'idle');
   assert.equal(app.element('phone-control-status').textContent, language === 'ja' ? '認識中' : 'Transcribing');
   assert.equal(discard.disabled, false, 'discard remains available during transcription');
   finishTranscript({ok: true, status: 200, json: async () => ({text: 'Synthetic transcript'})}); await flush();
   // Auto-send awaits a real Web Crypto digest; microtasks alone cannot settle it.
   if (autoSend) { await sentRequest; await flush(); }
   assert.equal(discard.disabled, true);
   assert.equal(app.networkCalls.filter(url => url.endsWith('/api/utterances')).length, autoSend ? 1 : 0);
   assert.equal(app.element('transcript').value, autoSend ? '' : 'Synthetic transcript');
   if (!autoSend) {
    app.element('transcript').value = 'Edited synthetic transcript'; app.element('transcript').oninput();
    await app.element('send').click(); await flush();
    assert.match(app.physical.get(2), /Edited synthetic transcript/);
   }
  });
 }
}

test('phone stop error keeps the retry action on the microphone and recovers its idle icon', async t => {
 let failStop = true;
 const app = await launch({language: 'en', microphone: open => open || !failStop}); t.after(app.close);
 await app.element('record').click(); await flush();
 await app.element('record').click(); await flush();
 assert.equal(app.element('record').dataset.recordState, 'stop-error');
 assert.equal(app.element('record').disabled, false);
 assert.equal(app.element('record').getAttribute('aria-label'), 'Retry stopping the microphone');
 assert.equal(app.element('phone-control-status').textContent, 'Retry stopping the microphone');
 failStop = false;
 await app.element('record').click(); await flush();
 assert.equal(app.element('record').dataset.recordState, 'idle');
 assert.equal(app.element('record').getAttribute('aria-label'), 'Start recording');
});

test('phone history count follows selection without changing G2 boundary navigation or blank history', async t => {
 const empty = await launch(); t.after(empty.close);
 assert.equal(empty.element('conversation-position').textContent, '0 / 0');
 const app = await launch({initialMessages: [proactive('first'), proactive('last')]}); t.after(app.close);
 assert.equal(app.element('conversation-position').textContent, '2 / 2');
 const previous = {textEvent: {eventType: sdk.OsEventTypeList.SCROLL_TOP_EVENT}};
 const next = {textEvent: {eventType: sdk.OsEventTypeList.SCROLL_BOTTOM_EVENT}};
 await app.emit(previous);
 const firstFrame = [...app.physical];
 assert.equal(app.element('conversation-position').textContent, '1 / 2');
 await app.advance(29_000);
 await app.emit(previous);
 assert.deepEqual([...app.physical], firstFrame);
 await app.advance(2000);
 assert.equal(app.hidden(), false, 'the boundary swipe still resets activity');
 await app.emit(next);
 const lastFrame = [...app.physical];
 assert.equal(app.element('conversation-position').textContent, '2 / 2');
 await app.emit(next);
 assert.deepEqual([...app.physical], lastFrame);
 assert.equal(app.element('previous').disabled, false);
 assert.equal(app.element('next').disabled, false);
});

for (const browseHistory of [false, true]) {
 test(`manual discard restores the ${browseHistory ? 'browsed' : 'latest'} conversation without replay or submission`, async t => {
  const app = await launch({initialMessages: [proactive('first'), proactive('second')]}); t.after(app.close);
  if (browseHistory) await app.element('previous').click();
  const expected = app.element('hud-content').textContent;
  app.element('transcript').value = 'Unsent draft';
  await app.evaluate('tts = true;');
  await app.element('record').click(); await flush();
  assert.equal(vm.runInContext('recorder.state', app.context), 'recording');
  assert.equal(app.element('record').dataset.recordState, 'recording');
  assert.equal(app.element('discard').disabled, false);
  await app.element('discard').click(); await flush();
  assert.equal(app.element('record').dataset.recordState, 'idle');
  assert.equal(app.element('discard').disabled, true);
  await app.advance(1000);
  assert.equal(app.element('hud-content').textContent, expected);
  assert.equal(app.physical.get(2), expected);
  assert.equal(app.element('notice').textContent, '録音を破棄しました。');
  assert.equal(app.element('transcript').value, 'Unsent draft');
  assert.equal(app.calls.filter(c => c[0] === 'speech').length, 0);
  assert.equal(app.networkCalls.some(url => /\/api\/(?:transcribe|utterances)$/.test(url)), false);
 });
}

test('manual discard without history keeps the idle prompt', async t => {
 const app = await launch(); t.after(app.close);
 await app.element('record').click(); await flush();
 await app.element('discard').click(); await flush();
 assert.equal(app.element('hud-content').textContent, '長押しで話してください');
 assert.equal(app.physical.get(2), '長押しで話してください');
});

test('discard during transcription restores the conversation and ignores a late transcript', async t => {
 let resolveTranscript, signal;
 const response = new Promise(resolve => { resolveTranscript = resolve; });
 const app = await launch({initialMessages: [proactive('previous')], request: (url, init) => {
  if (!url.endsWith('/api/transcribe')) return;
  signal = init.signal;
  return response;
 }}); t.after(app.close);
 app.element('auto-send').checked = true;
 await app.element('record').click(); await flush();
 await app.emit({audioEvent: {audioPcm: new Uint8Array(3200)}});
 await app.element('record').click(); await flush();
 assert.equal(vm.runInContext('busy', app.context), true);
 await app.element('discard').click(); await flush();
 assert.equal(signal.aborted, true);
 assert.equal(app.physical.get(2), 'Synthetic message previous');
 resolveTranscript({ok: true, status: 200, json: async () => ({text: 'Cancelled speech'})}); await flush();
 assert.equal(app.element('hud-content').textContent, 'Synthetic message previous');
 assert.equal(app.element('transcript').value, '');
 assert.equal(app.networkCalls.some(url => url.endsWith('/api/utterances')), false);
});

test('stale local ON cannot speak a fresh reply while native OFF is still restoring', async t => {
  let restore;
  const app = await launch({localReadAloud: true, nativeReadAloud: false,
    nativeRead: key => key === 'dot-read-aloud-preference-v1' ? new Promise(resolve => { restore = resolve; }) : undefined});
  t.after(app.close);
  assert.match(app.element('tts').getAttribute('aria-label'), /OFF$/);
  await app.deliver(app.snapshot([proactive('before-restore')]));
  assert.equal(app.calls.filter(c => c[0] === 'speech').length, 0);
  restore('false'); await flush();
  assert.match(app.element('tts').getAttribute('aria-label'), /OFF$/);
  await app.deliver(app.snapshot([proactive('before-restore'), proactive('after-restore')]));
  assert.equal(app.calls.filter(c => c[0] === 'speech').length, 0);
});

test('read-aloud choice persists through reopen without enable speech or history replay', async t => {
  const first = await launch(); t.after(first.close);
  await first.element('tts').click(); await flush();
  assert.equal(first.nativeSaved.get('dot-read-aloud-preference-v1'), 'true');
  await first.close();
  const history = [proactive('old')];
  const reopened = await launch({nativeReadAloud: true, initialMessages: history}); t.after(reopened.close);
  assert.match(reopened.element('tts').getAttribute('aria-label'), /ON$/);
  assert.equal(reopened.element('tts').getAttribute('aria-pressed'), 'true');
  assert.match(reopened.element('speech-status').textContent, /TTS:iPhone/);
  assert.equal(reopened.calls.filter(c => c[0] === 'speech').length, 0);
  await reopened.deliver(reopened.snapshot([...history, proactive('new')]));
  assert.deepEqual(reopened.calls.filter(c => c[0] === 'speech').map(c => c[1]), ['Synthetic message new']);
  await reopened.element('tts').click(); await flush();
  assert.equal(reopened.nativeSaved.get('dot-read-aloud-preference-v1'), 'false');
  await reopened.close();
  const off = await launch({nativeReadAloud: false, initialMessages: history}); t.after(off.close);
  assert.match(off.element('tts').getAttribute('aria-label'), /OFF$/);
  assert.equal(off.element('tts').getAttribute('aria-pressed'), 'false');
  await off.deliver(off.snapshot([...history, proactive('another')]));
  assert.equal(off.calls.filter(c => c[0] === 'speech').length, 0);
});

test('full app hides all 6 containers, keeps receiving, and wakes on a new autonomous message', async t => {
  const app = await launch(); t.after(app.close);
  await app.advance(30_000); assert.equal(app.hidden(), true);
  assert.deepEqual([...app.physical.values()], Array(6).fill(' '));
  const count = app.calls.length;
  for (let i = 0; i < 100; i++) await app.deliver(app.snapshot());
  assert.equal(app.calls.length, count, 'unchanged polls must not relight the display');
  await app.deliver(app.snapshot([proactive('one')]));
  assert.equal(app.hidden(), false); assert.match(app.physical.get(2), /Synthetic message one/);
  await app.advance(29_999); assert.equal(app.hidden(), false);
  await app.advance(1); assert.equal(app.hidden(), true);
  await app.advance(6 * 60_000);
  assert.equal(app.calls.some(c => c[0] === 'exit'), false, 'inactivity must never exit');
});

test('default double wake consumes the gesture; configurable single wake also swallows a trailing double', async t => {
  const app = await launch(); t.after(app.close);
  await app.deliver(app.snapshot([proactive('last')])); await app.advance(30_000);
  await app.emit(singleTap); assert.equal(app.hidden(), true);
  await app.emit(doubleTap); assert.equal(app.hidden(), false);
  assert.match(app.physical.get(2), /Synthetic message last/);
  await app.emit(doubleTap); assert.equal(app.calls.some(c => c[0] === 'exit'), false);
  await app.advance(700); await app.emit(doubleTap);
  assert.deepEqual(app.calls.filter(c => c[0] === 'exit'), [['exit', 1]], 'visible normal double keeps the existing exit dialog');
  app.element('display-wake-tap').value = 'single'; app.element('display-idle').value = '5';
  app.element('display-settings-form').onsubmit({preventDefault() {}}); await flush();
  assert.equal(JSON.parse(app.saved.get('dot-display-v1')).wakeTap, 'single');
  await app.advance(5000); await app.emit(singleTap); assert.equal(app.hidden(), false);
  await app.advance(100); await app.emit(doubleTap);
  assert.equal(app.calls.filter(c => c[0] === 'exit').length, 1);
});

test('recording and recognition stay protected; offline reply-wait releases protection after sixty seconds', async t => {
  const app = await launch(); t.after(app.close);
  await app.emit({sysEvent: {eventType: sdk.OsEventTypeList.LONG_PRESS_EVENT}});
  await app.advance(60_000); assert.equal(app.hidden(), false);
  assert.ok(app.calls.some(c => c[0] === 'mic' && c[1] === true));
  await app.emit({sysEvent: {eventType: sdk.OsEventTypeList.LONG_PRESS_RELEASE_EVENT}});
  for (const phase of ['recognizing', 'sending']) {
    await app.evaluate(`progress.begin('job', 'recognizing'); progress.setPhase('${phase}'); progress.connection='offline'; updateRuntime();`);
    await app.advance(90_000); assert.equal(app.hidden(), false);
  }
  await app.evaluate("progress.waiting('job'); updateRuntime();");
  await app.advance(59_999); assert.equal(app.hidden(),false);
  await app.advance(30_001); assert.equal(app.hidden(),true);
  await app.deliver(app.snapshot([{id: 'job', text: 'Synthetic request', reply: 'Synthetic reply', status: 'replied'}]));
  await app.advance(29_999); assert.equal(app.hidden(), false);
  await app.advance(1); assert.equal(app.hidden(), true);
});

test('IMU wakes only on a new head raise; holding the head up does not undo the idle timeout', async t => {
  const app = await launch(); t.after(app.close);
  assert.ok(app.calls.some(c => c[0] === 'imu' && c[1] === true));
  const imu = angle => ({sysEvent: {eventType: sdk.OsEventTypeList.IMU_DATA_REPORT,
    imuData: {x: Math.sin(angle * Math.PI / 180), y: 0, z: Math.cos(angle * Math.PI / 180)}}});
  await app.advance(30_000); await app.emit(imu(0)); await app.emit(imu(25));
  await app.advance(250); await app.emit(imu(25)); assert.equal(app.hidden(), false);
  for (let i = 0; i < 121; i++) { await app.advance(250); await app.emit(imu(25)); }
  assert.equal(app.hidden(), true);
  app.element('display-head-raise').checked = false;
  app.element('display-settings-form').onsubmit({preventDefault() {}}); await flush();
  assert.ok(app.calls.some(c => c[0] === 'imu' && c[1] === false));
  await app.advance(30_000); await app.emit(imu(0)); await app.emit(imu(30));
  await app.advance(250); await app.emit(imu(30)); assert.equal(app.hidden(), true);
});

test('new arrival wins a slow in-flight blank, with no later stale erase', async t => {
  const app = await launch(); t.after(app.close);
  const release = app.gate();
  await app.advance(30_000); assert.equal(app.hidden(), true);
  await app.deliver(app.snapshot([proactive('race')])); assert.equal(app.hidden(), false);
  release(); await flush();
  assert.match(app.physical.get(2), /Synthetic message race/);
  assert.notEqual(app.physical.get(3), ' ');
});


test('full app restores native pairing into empty updated WebView and resumes its changed port before reading data', async t => {
  const credentials = {origin:'https://mac.tailtest.ts.net',token:'o'.repeat(43),resumeToken:'r'.repeat(43),appOrigin:'http://127.0.0.1:55895',expiresAt:Date.now()+100000};
  const app = await launch({nativePairing:credentials}); t.after(app.close);
  assert.equal(app.calls.filter(c=>c[0]==='resume').length,1);
  assert.equal(JSON.parse(app.saved.get('dot-relay-v1')).appOrigin,'http://127.0.0.1:57157');
  assert.equal(JSON.parse(app.nativeSaved.get('dot-relay-native-v1')).token,'n'.repeat(43));
  assert.equal(app.element('dot-status').textContent,'Test Mac · Dot接続済み');
  await app.deliver(app.snapshot([proactive('after-update')]));
  assert.match(app.physical.get(2),/after-update/);
});

test('temporary recovery failure preserves credentials and retries without asking for a new pairing code', async t => {
  const credentials = {origin:'https://mac.tailtest.ts.net',token:'o'.repeat(43),resumeToken:'r'.repeat(43),appOrigin:'http://127.0.0.1:55895',expiresAt:Date.now()+100000};
  const app = await launch({nativePairing:credentials,failResumeOnce:true}); t.after(app.close);
  assert.equal(JSON.parse(app.nativeSaved.get('dot-relay-native-v1')).resumeToken,credentials.resumeToken);
  // LiveUpdates is imported as a real module and owns its own retry timer.
  await new Promise(resolve=>setTimeout(resolve,1100)); await flush();
  assert.equal(app.calls.filter(c=>c[0]==='resume').length,2);
  await app.deliver(app.snapshot());
  assert.equal(app.element('dot-status').textContent,'Test Mac · Dot接続済み');
});

test('IMU reports without coordinates and unknown system events are not user activity', async t => {
  const app = await launch(); t.after(app.close);
  for (let n=0; n<40; n++) {
    await app.emit({sysEvent:{eventType:sdk.OsEventTypeList.IMU_DATA_REPORT}});
    await app.emit({sysEvent:{eventType:99}});
    await app.advance(1000);
  }
  assert.equal(app.hidden(),true,'sensor/status reports must not keep resetting the 30-second idle deadline');
  assert.deepEqual([...app.physical.values()],Array(6).fill(' '));
});


test('head raises while already visible do not keep postponing the initial 30-second timeout', async t => {
  const app = await launch(); t.after(app.close);
  const imu = angle => ({sysEvent:{eventType:sdk.OsEventTypeList.IMU_DATA_REPORT,imuData:{x:Math.sin(angle*Math.PI/180),y:0,z:Math.cos(angle*Math.PI/180)}}});
  for(let n=0;n<29;n++) {
    await app.emit(imu(0)); await app.advance(400);
    await app.emit(imu(25)); await app.advance(200);
    await app.emit(imu(25)); await app.advance(400);
  }
  assert.equal(app.hidden(),false);
  await app.advance(1000); assert.equal(app.hidden(),true);
  await app.emit(imu(0)); await app.advance(400);
  await app.emit(imu(25)); await app.advance(200); await app.emit(imu(25));
  assert.equal(app.hidden(),false,'the same gesture still wakes when hidden');
});


test('actual text-entry handler only sends text; current STT and client TTS labels update without audio calls', async t => {
  const app = await launch({typedInput: true, provider: 'soniox'}); t.after(app.close);
  assert.equal(app.element('speech-status').textContent, 'STT:Soniox stt-rt-v5 / TTS:OFF');
  assert.equal(app.physical.get(4), '─'.repeat(24) + '\n' + 'STT:Soniox stt-rt-v5 / TTS:OFF');
  app.element('transcript').value = 'Synthetic typed input';
  app.element('transcript').oninput();
  await app.element('send').click(); await flush();
  assert.equal(app.networkCalls.filter(path => path.endsWith('/api/utterances')).length, 1);
  assert.equal(app.networkCalls.filter(path => path.endsWith('/api/transcribe')).length, 0);
  assert.equal(app.calls.filter(call => call[0] === 'mic').length, 0);
  await app.element('tts').click(); await flush();
  assert.equal(app.element('speech-status').textContent, 'STT:Soniox stt-rt-v5 / TTS:iPhone');
  assert.equal(app.physical.get(4), '─'.repeat(24) + '\n' + 'STT:Soniox stt-rt-v5 / TTS:iPhone');
  const state = app.snapshot(); state.status.sttProvider = 'whisper';
  await app.deliver(state);
  assert.equal(app.physical.get(4), '─'.repeat(24) + '\n' + 'STT:Whisper small / TTS:iPhone');
  delete state.status.sttProvider; await app.deliver(state);
  assert.equal(app.physical.get(4), '─'.repeat(24) + '\n' + 'STT:— / TTS:iPhone');
  await app.evaluate("progress.connection = 'offline'; updateRuntime()");
  assert.equal(app.element('speech-status').textContent, 'STT:— / TTS:iPhone');
});


test('all provider and actual model labels reach both phone and G2 through status updates', async t => {
  const app = await launch({provider: 'whisper'}); t.after(app.close);
  for (const [provider, label] of Object.entries({whisper:'Whisper small',soniox:'Soniox stt-rt-v5',elevenlabs:'ElevenLabs scribe_v2',microsoft:'Microsoft MAI-Transcribe-2',openai:'OpenAI gpt-transcribe',assemblyai:'AssemblyAI universal-3-5-pro'})) {
    const state = app.snapshot(); state.status.sttProvider = provider;
    await app.deliver(state);
    assert.equal(app.element('speech-status').textContent, `STT:${label} / TTS:OFF`);
    assert.equal(app.physical.get(4), '─'.repeat(24) + '\n' + `STT:${label} / TTS:OFF`);
  }
  const state = app.snapshot(); state.status.sttProvider = 'openai'; state.status.sttModel = 'fixture-model';
  await app.deliver(state);
  assert.equal(app.element('speech-status').textContent, 'STT:OpenAI fixture-model / TTS:OFF');
  assert.equal(app.physical.get(4), '─'.repeat(24) + '\nSTT:OpenAI fixture-model / TTS:OFF');
  assert.equal(app.calls.filter(call => call[0] === 'mic').length, 0);
});


test('language switches preserve the live session, draft, TTS, history position and future delivery', async t => {
  const app = await launch({provider: 'elevenlabs'}); t.after(app.close);
  const first = {id: 'first', kind: 'voice', text: 'Display settings', reply: '長押しで話してください', status: 'replied'};
  await app.deliver(app.snapshot([first, proactive('second')]));
  await app.element('previous').click(); await flush();
  app.element('transcript').value = 'Unsent draft';
  await app.element('tts').click(); await flush();
  const credentials = app.saved.get('g2-device-token');
  const beforeRequests = app.networkCalls.length;
  app.element('pair-code').value = 'invalid'; app.element('pair-code').oninput();
  for (const locale of ['en', 'ja', 'en']) {
    app.element('language').value = locale; app.element('language').onchange(); await flush();
    assert.equal(app.context.document.documentElement.lang, locale);
    assert.equal(app.element('pair-notice').textContent, locale === 'en'
      ? 'The pairing code is invalid or expired. Create a new one on your Mac.'
      : '接続コードが無効か期限切れです。Macで新しく発行してください。');
    assert.equal(app.element('static-test-label').textContent, locale === 'en' ? 'Display settings' : '表示設定');
    assert.match(app.element('tts').getAttribute('aria-label'), /ON$/);
    assert.equal(app.element('tts').getAttribute('aria-pressed'), 'true');
    assert.equal(app.element('record').getAttribute('aria-label'), locale === 'en' ? 'Start recording' : '録音を開始');
    assert.equal(app.element('discard').getAttribute('aria-label'), locale === 'en' ? 'Discard recording' : '録音を破棄');
    assert.equal(app.element('transcript').placeholder, locale === 'en' ? 'Message Dot…' : 'Dotにメッセージ…');
    assert.equal(app.element('record').disabled, false);
    assert.equal(app.element('transcript').value, 'Unsent draft');
    assert.match(app.physical.get(2), /Display settings\n\nDot: 長押しで話してください$/);
    assert.ok(app.physical.get(2).startsWith(locale === 'en' ? 'You: ' : 'あなた: '));
    assert.match(app.physical.get(1), /1\/2/);
    assert.equal(app.element('g2-diagnostic').textContent, 'G2_READY');
  }
  assert.equal(app.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(app.calls.filter(c => c[0] === 'exit').length, 0);
  assert.equal(app.networkCalls.length, beforeRequests, 'language change never restarts the receiver or sends data');
  assert.equal(app.saved.get('g2-device-token'), credentials);
  assert.equal(app.nativeSaved.get('dot-language-preference-v1'), 'en');
  await app.deliver(app.snapshot([first, proactive('second'), proactive('third')]));
  assert.match(app.physical.get(2), /Display settings/);
  assert.equal(app.physical.get(6), '2 new');
  await app.element('next').click(); await flush();
  assert.equal(app.physical.get(2), 'Synthetic message second');
  await app.element('next').click(); await flush();
  assert.equal(app.physical.get(2), 'Synthetic message third');
});

test('automatic locale uses Japanese only for Japanese and follows host changes without restart', async t => {
  const app = await launch({language: 'fr-FR'}); t.after(app.close);
  assert.equal(app.element('language').value, 'auto');
  assert.equal(app.context.document.documentElement.lang, 'en');
  await app.locale('ja-JP'); assert.equal(app.context.document.documentElement.lang, 'ja');
  app.element('language').value = 'en'; app.element('language').onchange(); await flush();
  await app.locale('ja-JP'); assert.equal(app.context.document.documentElement.lang, 'en');
  app.element('language').value = 'auto'; app.element('language').onchange(); await flush();
  assert.equal(app.context.document.documentElement.lang, 'ja');
  await app.locale('zh-CN'); assert.equal(app.context.document.documentElement.lang, 'en');
  assert.equal(app.calls.filter(c => c[0] === 'create').length, 1);
});

test('language change keeps a hidden display blank and recording guard preserves preference', async t => {
  const app = await launch(); t.after(app.close);
  await app.advance(30_000);
  app.element('language').value = 'en'; app.element('language').onchange(); await flush();
  assert.equal(app.hidden(), true); assert.deepEqual([...app.physical.values()], Array(6).fill(' '));
  await app.emit(doubleTap);
  await app.emit({textEvent: {eventType: sdk.OsEventTypeList.LONG_PRESS_EVENT}});
  app.element('language').value = 'ja'; app.element('language').onchange(); await flush();
  assert.equal(app.element('language').value, 'en');
  assert.equal(app.context.document.documentElement.lang, 'en');
});

test('native language is restored into a new WebView without replacing G2 startup', async t => {
  const app = await launch({language: 'en-US', nativeLanguage: 'ja'}); t.after(app.close);
  assert.equal(app.context.document.documentElement.lang, 'ja');
  assert.equal(app.element('language').value, 'ja');
  assert.equal(app.calls.filter(c => c[0] === 'create').length, 1);
});

test('location toggle reaches native/relay and an OFF blocks late announcements in the whole app', async t => {
  const app = await launch(); t.after(app.close);
  assert.equal(app.calls.some(c => c[0] === 'location-start'), false);
  app.element('location-share').checked = true;
  app.element('location-share').onchange(); await flush();
  assert.equal(app.calls.filter(c => c[0] === 'location-start').length, 1);
  const control = app.calls.find(c => c[0] === 'location-api' && c[2].enabled === true);
  assert.ok(control, JSON.stringify({calls: app.calls, network: app.networkCalls, state: app.element("location-status").textContent}));
  const message = {...proactive('location-first'), location_sharing_id: control[2].sharing_id,
    location_expires_at: new Date(Date.now() + 90_000).toISOString()};
  await app.deliver(app.snapshot([message]));
  assert.match(app.physical.get(2), /location-first/);
  app.element('location-share').checked = false;
  app.element('location-share').onchange(); await flush();
  assert.ok(app.calls.some(c => c[0] === 'location-stop'));
  assert.ok(app.calls.some(c => c[0] === 'location-api' && c[2].enabled === false));
  await app.advance(30_000); assert.equal(app.hidden(), true);
  await app.deliver(app.snapshot([message, {...message, id: 'late', reply: 'Late location announcement'}]));
  assert.equal(app.hidden(), true);
  assert.equal([...app.physical.values()].some(text => text.includes('Late location')), false);
});

test('whole app waits sixty seconds then uses configured idle interval, preserving late replies and all header fields', async t => {
  const app = await launch({typedInput:true,provider:'soniox'}); t.after(app.close);
  app.element('transcript').value = 'Synthetic waiting question'; await app.element('send').click(); await flush();
  const message = vm.runInContext('JSON.parse(JSON.stringify(conversation.selected))',app.context);
  assert.match(app.physical.get(1), /^Dotの返信待ち \(0秒\)$/);
  assert.match(app.physical.get(5), /^未読 \d{2}:\d{2}$/);
  const time = app.physical.get(5).slice(3);
  const stt = app.physical.get(4);
  await app.advance(30_000); assert.equal(app.hidden(),false);
  await app.deliver(app.snapshot([{...message,readAt:new Date(app.now()).toISOString()}]));
  assert.equal(app.physical.get(5),`既読 ${time}`);
  assert.equal(app.physical.get(6),' ');
  await app.advance(29_999); assert.equal(app.hidden(),false);
  assert.match(app.physical.get(2), /Dot: 返信を待っています…$/);
  await app.advance(1);
  assert.match(app.physical.get(2), /Dot: 通常より返信に時間がかかっています…$/);
  assert.equal(app.physical.get(4),stt);
  await app.advance(29_999); assert.equal(app.hidden(),false);
  await app.advance(1); assert.equal(app.hidden(),true);
  assert.deepEqual([...app.physical.values()],Array(6).fill(' '));
  await app.deliver(app.snapshot([{...message,reply:'Synthetic late answer',repliedAt:new Date(app.now()).toISOString(),status:'replied'}]));
  assert.equal(app.hidden(),false);
  assert.match(app.physical.get(2), /Dot: Synthetic late answer$/);
  assert.match(app.physical.get(1), /^1\/1 90\.0秒$/);
  assert.equal(app.calls.some(c=>c[0]==='exit'),false);
});

test('operation after the delayed notice restarts idle time, including with the phone page hidden', async t => {
  const app = await launch({typedInput:true}); t.after(app.close);
  app.element('transcript').value='Synthetic question'; await app.element('send').click(); await flush();
  await app.evaluate('document.hidden = true; pageActive = false; updateRuntime();');
  await app.advance(75_000); assert.equal(app.hidden(),false);
  await app.emit(singleTap);
  await app.advance(29_999); assert.equal(app.hidden(),false);
  await app.advance(1); assert.equal(app.hidden(),true);
});

test('a burst displays the first arrival once, counts later replies, and keeps the current body untouched on metadata polls', async t => {
  const app = await launch(); t.after(app.close);
  const first = {...proactive('one'),createdAt:'2026-10-12T12:00:00Z'};
  const second = {...proactive('two'),createdAt:'2026-10-12T12:00:01Z'};
  const third = {...proactive('three'),createdAt:'2026-10-12T12:00:02Z'};
  await app.deliver(app.snapshot([first,second]));
  assert.equal(app.physical.get(2),first.reply);
  assert.equal(app.physical.get(6),'新着1件');
  assert.equal(app.physical.get(5),' ');
  const bodyWrites = app.calls.filter(c=>c[0]==='text' && c[1]===2).length;
  await app.deliver(app.snapshot([first,second,third]));
  assert.equal(app.physical.get(2),first.reply);
  assert.equal(app.physical.get(6),'新着2件');
  assert.equal(app.calls.filter(c=>c[0]==='text' && c[1]===2).length,bodyWrites);
  for(let i=0;i<3;i++) await app.deliver(app.snapshot([first,second,third]));
  assert.equal(app.calls.filter(c=>c[0]==='text' && c[1]===2).length,bodyWrites);
  await app.element('next').click(); await flush();
  assert.equal(app.physical.get(2),second.reply); assert.equal(app.physical.get(6),'新着1件');
  await app.element('next').click(); await flush();
  assert.equal(app.physical.get(2),third.reply); assert.equal(app.physical.get(6),' ');
});

test('reopening an old pending message restores its receipt and delayed notice without restarting sixty-second protection', async t => {
  const message={id:'old-pending',text:'Synthetic old question',status:'accepted',createdAt:new Date(Date.now()-65_000).toISOString(),readAt:new Date(Date.now()-60_000).toISOString()};
  const app=await launch({initialMessages:[message]});t.after(app.close);
  assert.match(app.physical.get(5),/^既読 /);
  assert.match(app.physical.get(2),/Dot: 通常より返信に時間がかかっています…$/);
  await app.advance(29_999);assert.equal(app.hidden(),false);
  await app.advance(1);assert.equal(app.hidden(),true);
});

test('download URL copy uses displayed text and failure never focuses a field', async t => {
  const app = await launch(); t.after(app.close);
  const url = 'https://github.com/YusukeIt0/dot-link/releases/latest';
  const display = app.element('mac-download-url'); display.textContent = url;
  display.focus = display.select = display.setSelectionRange = () => { throw new Error('Display URL must never receive programmatic input focus'); };
  let copied;
  app.context.navigator.clipboard = {writeText: async value => {copied = value;}};
  await app.element('copy-mac-url').click();
  assert.equal(copied, url);
  assert.match(app.element('mac-copy-status').textContent, /URLをコピーしました/);
  app.context.navigator.clipboard.writeText = async () => {throw new Error('Denied');};
  await app.element('copy-mac-url').click();
  assert.match(app.element('mac-copy-status').textContent, /コピーできませんでした/);
  assert.match(app.element('copy-toast').textContent, /コピーできませんでした/);
});


test('native wake-name save failure remains visible after a newer draft, and a later successful save clears it', async t => {
  const writes = [];
  const app = await launch({nativeWrite: (key) => key === 'dot-wake-name-v1' ? new Promise(resolve => writes.push(resolve)) : true});
  t.after(app.close);
  app.element('custom-wake-name').checked = true;
  app.element('wake-name').value = 'Sakura';
  app.element('wake-name-form').onsubmit({preventDefault() {}}); await flush();
  app.element('wake-name').value = 'Nova'; app.element('wake-name').oninput();
  writes.shift()(false); await flush();
  assert.equal(app.element('wake-name').value, 'Nova');
  assert.match(app.element('wake-name-status').textContent, /変更はまだ保存されていません/);
  assert.match(app.element('wake-name-save-status').textContent, /設定を保存できません/);
  assert.equal(app.calls.some(c => c[0] === 'mic' && c[1]), false);
  app.element('wake-name-form').onsubmit({preventDefault() {}}); await flush();
  writes.shift()(true); await flush();
  assert.equal(app.element('wake-name-save-status').textContent, '');
  assert.equal(app.element('wake-name-status').textContent, '呼び名を保存しました');
});

test('a failed older name save cannot overwrite the result of a newer save', async t => {
  const writes = [];
  const app = await launch({nativeWrite: (key) => key === 'dot-wake-name-v1' ? new Promise(resolve => writes.push(resolve)) : true});
  t.after(app.close);
  app.element('custom-wake-name').checked = true;
  app.element('wake-name').value = 'Sakura';
  app.element('wake-name-form').onsubmit({preventDefault() {}}); await flush();
  app.element('wake-name').value = 'Nova'; app.element('wake-name').oninput();
  app.element('wake-name-form').onsubmit({preventDefault() {}}); await flush();
  writes.shift()(false); await flush();
  assert.equal(app.element('wake-name-save-status').textContent, '');
  writes.shift()(true); await flush();
  assert.equal(app.element('wake-name-save-status').textContent, '');
  assert.equal(app.element('wake-name-status').textContent, '呼び名を保存しました');
});

for (const exitType of [sdk.OsEventTypeList.SYSTEM_EXIT_EVENT, sdk.OsEventTypeList.ABNORMAL_EXIT_EVENT]) {
 test(`confirmed exit ${exitType} after OFF-ON stops the latest location session`, async t => {
  const app = await launch({exitDiagnostics: true}); t.after(app.close);
  for (const enabled of [true, false, true]) {
   app.element('location-share').checked = enabled;
   app.element('location-share').onchange(); await flush();
  }
  const enabled = app.calls.filter(c=>c[0]==='location-api' && c[2].enabled===true);
  assert.equal(enabled.length,2);
  assert.notEqual(enabled[0][2].sharing_id,enabled[1][2].sharing_id);
  await app.emit({sysEvent:{eventType:exitType}});
  assert.ok(app.calls.some(c=>c[0]==='location-api' && c[2].enabled===false && c[2].sharing_id===enabled[1][2].sharing_id));
  const trace = JSON.parse(app.saved.get('dot-exit-check-v1')).map(row => row.event);
  assert.ok(trace.includes(exitType === 7 ? 'system-exit' : 'abnormal-exit'));
  assert.ok(trace.includes('stop-session'));
  assert.equal(trace.filter(event => event === 'share-disable').length, 2);
  const count=app.calls.filter(c=>c[0]==='location-api').length;
  await app.advance(180000);
  assert.equal(app.calls.filter(c=>c[0]==='location-api').length,count);
 });
}

test('opening and cancelling the system exit dialog keeps sharing alive', async t => {
  const app = await launch(); t.after(app.close);
  app.element('location-share').checked = true;
  app.element('location-share').onchange(); await flush();
  await app.emit(doubleTap);
  assert.ok(app.calls.some(c => c[0] === 'exit' && c[1] === 1));
  await app.emit({sysEvent: {eventType: sdk.OsEventTypeList.FOREGROUND_ENTER_EVENT}});
  await app.emit({sysEvent: {eventType: sdk.OsEventTypeList.FOREGROUND_EXIT_EVENT}});
  const before = app.calls.filter(c => c[0] === 'location-api').length;
  await app.advance(31_000);
  await app.evaluate('void locationSharing.pump()');
  assert.ok(app.calls.filter(c => c[0] === 'location-api').length > before);
  assert.equal(app.calls.some(c => c[0] === 'location-api' && c[2].enabled === false), false);
});


test('a send response parsed after forgetting cannot restore history or release a newer busy operation', async t => {
 let releaseBody, parsing=false;
 const body=new Promise(resolve=>{releaseBody=resolve;});
 const app=await launch({typedInput:true,request:(url)=>url.endsWith('/api/utterances')
  ? Promise.resolve({ok:true,status:200,json:()=>{parsing=true;return body;}}) : undefined});
 t.after(app.close);
 app.element('transcript').value='Synthetic pending request';
 const sending=app.element('send').click();
 for(let i=0;i<20&&!parsing;i++) await new Promise(resolve=>setImmediate(resolve));
 assert.equal(parsing,true);
 await app.evaluate("forgetPairing('Reconnect required'); busy=true; progress.connection='connecting';");
 releaseBody({id:'old',text:'Synthetic pending request',status:'accepted'});await sending;await flush();
 assert.equal(vm.runInContext('conversation.count',app.context),0);
 assert.equal(vm.runInContext('busy',app.context),true);
 assert.equal(app.element('pair-notice').textContent,'Reconnect required');
 assert.equal(app.element('notice').textContent,'');
 assert.equal(app.element('transcript').value,'Synthetic pending request');
});

test('forget clears the queued restore/wake state and preserves the unsent draft and user preferences', async t => {
 const app=await launch({initialMessages:[proactive('history')]});t.after(app.close);
 app.element('transcript').value='Unsent draft';
 await app.evaluate("tts=true; pendingId='old'; pendingText='old'; conversation.receive([{id:'queued',text:'',status:'replied',reply:'Old reply'}],false,()=>true);");
 await app.evaluate("forgetPairing('Reconnect required');");
 assert.equal(vm.runInContext('conversation.count',app.context),0);
 assert.equal(vm.runInContext('conversation.unreadCount',app.context),0);
 assert.equal(vm.runInContext('pendingId',app.context),undefined);
 assert.equal(vm.runInContext('pendingText',app.context),undefined);
 assert.equal(vm.runInContext('tts',app.context),true);
 assert.equal(app.element('transcript').value,'Unsent draft');
 await app.evaluate('conversation.receive([],true,()=>true); flushPendingDisplay();');
 assert.equal(vm.runInContext('conversation.visibleId',app.context),undefined);
});

test('pairing failure reopens setup if it was closed while the request was pending', async t => {
 const origin='https://relay.example.ts.net';
 let rejectPair;
 const app=await launch({request:url=>url===`${origin}/api/pair`
  ? new Promise((resolve,reject)=>{rejectPair=reject;}) : undefined});
 t.after(app.close);
 app.element('notice').textContent='Current runtime feedback';
 app.element('mac-setup').open=true;
 app.element('pair-code').value=JSON.stringify({version:1,origin,code:'c'.repeat(43),expiresAt:Date.now()+60000});
 const pending=app.element('pair').click(); await flush();
 assert.equal(typeof rejectPair,'function');
 app.element('mac-setup').open=false;
 app.element('mac-setup').dispatchEvent({type:'toggle'});
 rejectPair(new Error('Offline')); await pending; await flush();
 assert.equal(app.element('mac-setup').open,true);
 assert.equal(app.element('pair-notice').textContent,'Macが停止・スリープ・オフラインの場合は接続できません。');
 assert.equal(app.element('notice').textContent,'Current runtime feedback');
});

test('successful pairing releases the send control for a preserved draft', async t => {
 const origin='https://relay.example.ts.net';
 const app=await launch({request:url=>url===`${origin}/api/pair`
  ? Promise.resolve({ok:true,status:200,json:async()=>({token:'p'.repeat(43),expiresAt:Date.now()+86400000})})
  : url===`${origin}/api/updates`
   ? Promise.resolve({ok:true,status:200,json:async()=>({revision:'paired',status:{subscribed:true},messages:[]})}) : undefined});
 t.after(app.close);
 app.element('transcript').value='Preserved draft';
 app.element('pair-code').value=JSON.stringify({version:1,origin,code:'c'.repeat(43),expiresAt:Date.now()+60000});
 await app.element('pair').click(); await flush();
 assert.equal(vm.runInContext('session.credentials?.origin',app.context),origin);
 assert.equal(vm.runInContext('busy',app.context),false);
 assert.equal(app.element('send').disabled,false);
 assert.equal(app.element('transcript').value,'Preserved draft');
 assert.equal(app.element('mac-setup').open,false);
 assert.equal(app.element('pair-notice').textContent,'');
 assert.match(app.element('notice').textContent,/接続しました/);
});

for (const paired of [true, false]) {
 test(`closing setup ${paired ? 'dismisses paired' : 'preserves unpaired'} feedback`, async t => {
  const app=await launch(); t.after(app.close);
  if (!paired) await app.evaluate("forgetPairing('Reconnect required')");
  app.element('pair-notice').textContent='Previous pairing feedback';
  app.element('notice').textContent='Current runtime feedback';
  app.element('mac-setup').open=false;
  app.element('mac-setup').dispatchEvent({type:'toggle'});
  assert.equal(app.element('pair-notice').textContent,paired ? '' : 'Previous pairing feedback');
  assert.equal(app.element('notice').textContent,'Current runtime feedback');
 });
}

test('presentation refreshes do not flush speech or change input and standby policy', async t => {
 const app=await launch();t.after(app.close);
 await app.evaluate(`globalThis.effectCalls=[];
  const originalContext=recorder.setContext.bind(recorder);
  recorder.setContext=(...args)=>{effectCalls.push('voice');originalContext(...args);};
  const originalProtect=standby.protect.bind(standby);
  standby.protect=value=>{effectCalls.push('standby');originalProtect(value);};
  tts=true;busy=true;playback.speak(new SpeechSynthesisUtterance('Deferred synthetic reply'));busy=false;
  for(let i=0;i<20;i++) refreshStatus();
  display('Presentation only','Synthetic display');
  languagePreferences.value='en';applyLanguage();`);
 assert.equal(vm.runInContext('effectCalls.length',app.context),0);
 assert.equal(app.calls.filter(c=>c[0]==='speech').length,0);
 app.element('transcript').oninput();await flush();
 assert.equal(app.calls.filter(c=>c[0]==='speech').length,1);
 assert.ok(vm.runInContext("effectCalls.includes('voice') && effectCalls.includes('standby')",app.context));
});

test('offline waiting protection expires even with presentation refresh disabled',async t=>{
 const app=await launch();t.after(app.close);
 await app.evaluate(`progress.begin('wait','sending');progress.waiting('wait');progress.connection='offline';updateRuntime();
  clearInterval(statusTimer);statusTimer=undefined;refreshStatus=()=>{};`);
 await app.advance(59999);assert.equal(app.hidden(),false);
 await app.advance(1);assert.equal(app.hidden(),false);
 await app.advance(29999);assert.equal(app.hidden(),false);
 await app.advance(1);assert.equal(app.hidden(),true);
});

test('a reply deferred during recording is spoken once recording ends without presentation refresh',async t=>{
 const app=await launch();t.after(app.close);
 await app.evaluate('tts=true;');
 await app.emit({sysEvent:{eventType:sdk.OsEventTypeList.LONG_PRESS_EVENT}});
 assert.equal(vm.runInContext('recorder.state',app.context),'recording');
 await app.evaluate('refreshStatus=()=>{};');
 await app.deliver(app.snapshot([proactive('during-recording')]));
 assert.equal(app.calls.filter(c=>c[0]==='speech').length,0);
 await app.emit({sysEvent:{eventType:sdk.OsEventTypeList.LONG_PRESS_RELEASE_EVENT}});
 await flush();
 assert.equal(vm.runInContext('recorder.state',app.context),'idle');
 assert.equal(app.calls.filter(c=>c[0]==='speech').length,1);
 await app.advance(2000);
 assert.equal(app.calls.filter(c=>c[0]==='speech').length,1);
});

async function setHoldDisabled(app, disabled) {
  app.element('disable-hold-recording').checked = disabled;
  app.element('disable-hold-recording').onchange();
  await flush();
}
const holdEvent = {sysEvent:{eventType:sdk.OsEventTypeList.LONG_PRESS_EVENT}};
const releaseEvent = {sysEvent:{eventType:sdk.OsEventTypeList.LONG_PRESS_RELEASE_EVENT}};
test('disabled holds ignore every event envelope without waking the display; text still sends', async t => {
  const app=await launch({typedInput:true});t.after(app.close);
  await setHoldDisabled(app,true);
  assert.equal(app.element('record').disabled,true);
  assert.match(app.element('hud-content').textContent,/テキスト/);
  assert.equal(app.nativeSaved.get('dot-disable-hold-recording-v1'),'true');
  await app.advance(30000);assert.equal(app.hidden(),true);
  const before=app.calls.filter(c=>c[0]==='mic').length;
  for (const envelope of ['sysEvent','textEvent','listEvent']) {
    for (let i=0;i<3;i++) {
      await app.emit({[envelope]:{eventType:sdk.OsEventTypeList.LONG_PRESS_EVENT}});
      await app.emit({[envelope]:{eventType:sdk.OsEventTypeList.LONG_PRESS_RELEASE_EVENT}});
    }
  }
  assert.equal(app.hidden(),true);
  assert.equal(app.calls.filter(c=>c[0]==='mic').length,before);
  // Even an invoked handler cannot bypass the disabled phone button.
  await app.element('record').onclick();await flush();
  assert.equal(vm.runInContext('recorder.state',app.context),'idle');
  app.element('transcript').value='Synthetic text while holds disabled';app.element('transcript').oninput();
  await app.element('send').onclick();await flush();
  assert.ok(app.networkCalls.some(url=>url.endsWith('/api/utterances')));
  await setHoldDisabled(app,false);
  await app.emit(holdEvent);
  assert.equal(vm.runInContext('recorder.state',app.context),'recording');
  await app.emit(releaseEvent);
  assert.equal(vm.runInContext('recorder.state',app.context),'idle');
});

test('enabling the option discards an active manual recording without transcribing or sending', async t => {
  for (const fromPhone of [false,true]) {
    const app=await launch();t.after(app.close);
    if(fromPhone) await app.element('record').onclick();else await app.emit(holdEvent);
    await flush();assert.equal(vm.runInContext('recorder.state',app.context),'recording');
    await app.emit({audioEvent:{audioPcm:new Uint8Array(16000),source:sdk.AudioInputSource.Glasses}});
    await setHoldDisabled(app,true);
    assert.equal(vm.runInContext('recorder.state',app.context),'idle');
    assert.ok(app.calls.some(c=>c[0]==='mic'&&c[1]===false));
    assert.equal(app.networkCalls.some(url=>/transcribe|utterances/.test(url)),false);
    assert.equal(app.element('record').disabled,true);
    await app.emit(releaseEvent);
    assert.equal(vm.runInContext('recorder.state',app.context),'idle');
  }
});

test('wake input stays independent and disabled hold edges cannot take over or stop it', async t => {
  let wake;
  const detector={listen(){},cancel(){},hold(){assert.fail('disabled hold took over wake');},finish(){wake({type:'clip',seconds:1});},append(){},dispose(){}};
  const app=await launch({loadWake:async emit=>{wake=emit;return detector;}});t.after(app.close);
  await setHoldDisabled(app,true);
  assert.equal(vm.runInContext('operationPreferences.wakeWord',app.context),false);
  app.element('wake-word').checked=true;app.element('wake-word').onchange();await flush();
  assert.match(app.element('hud-content').textContent,/Hey dotで話せます/);
  wake({type:'wake'});await flush();
  assert.equal(vm.runInContext('recorder.source',app.context),'wake');
  assert.equal(vm.runInContext('recorder.state',app.context),'recording');
  await app.emit(holdEvent);await app.emit(releaseEvent);
  await setHoldDisabled(app,true);
  assert.equal(vm.runInContext('recorder.source',app.context),'wake');
  assert.equal(vm.runInContext('recorder.state',app.context),'recording');
  // Explicit stop remains available even though manual start is disabled.
  assert.equal(app.element('record').disabled,false);
  await app.element('record').onclick();await flush();
  assert.equal(vm.runInContext('recorder.state',app.context),'idle');
  assert.equal(app.element('record').disabled,true);
});

test('hold events are gated until native preferences restore and remain disabled after reopening', async t => {
  let restore;
  const app=await launch({nativeRead:key=>key==='dot-disable-hold-recording-v1'?new Promise(r=>{restore=r;}):''});t.after(app.close);
  await app.emit(holdEvent);
  assert.equal(vm.runInContext('recorder.state',app.context),'idle');
  restore('true');await flush();
  assert.equal(app.element('disable-hold-recording').checked,true);
  await app.emit(holdEvent);assert.equal(vm.runInContext('recorder.state',app.context),'idle');
  const reopened=await launch({language:'en',nativeRead:key=>app.nativeSaved.get(key)??app.saved.get(key)??''});t.after(reopened.close);
  assert.equal(reopened.element('disable-hold-recording').checked,true);
  assert.match(reopened.element('hud-content').textContent,/Type a message/);
  await reopened.emit(holdEvent);assert.equal(vm.runInContext('recorder.state',reopened.context),'idle');
});

test('a failed setting save reports failure while immediately preventing new recording', async t => {
  const app=await launch({nativeWrite:key=>key!=='dot-disable-hold-recording-v1'});t.after(app.close);
  await setHoldDisabled(app,true);
  assert.match(app.element('hold-save-status').textContent,/設定を保存できませんでした/);
  app.element('wake-word').checked=false;app.element('wake-word').onchange();await flush();
  assert.match(app.element('hold-save-status').textContent,/設定を保存できませんでした/);
  await app.emit(holdEvent);assert.equal(vm.runInContext('recorder.state',app.context),'idle');
});


test('disabling while microphone start or stop is pending never transcribes the manual clip', async t => {
  for (const pendingOpen of [true,false]) {
    let release;
    const app=await launch({microphone:open=>open===pendingOpen?new Promise(resolve=>{release=resolve;}):true});t.after(app.close);
    await app.emit(holdEvent);
    if(!pendingOpen) {
      await app.emit({audioEvent:{audioPcm:new Uint8Array(16000),source:sdk.AudioInputSource.Glasses}});
      await app.emit(releaseEvent);
    }
    assert.equal(vm.runInContext('recorder.state',app.context),pendingOpen?'starting':'stopping');
    await setHoldDisabled(app,true);
    release(true);await flush();
    assert.equal(vm.runInContext('recorder.state',app.context),'idle');
    assert.equal(app.networkCalls.some(url=>/transcribe|utterances/.test(url)),false);
    assert.equal(app.element('record').disabled,true);
  }
});

test('changing hold policy updates G2 help without replacing the displayed reply', async t => {
  const app=await launch();t.after(app.close);
  await app.deliver(app.snapshot([proactive('keep-reply')]));
  const reply=app.physical.get(2);
  await setHoldDisabled(app,true);
  assert.equal(app.physical.get(2),reply);
  assert.equal(app.physical.get(3),'長押し録音は無効です');
  await setHoldDisabled(app,false);
  assert.equal(app.physical.get(2),reply);
  assert.match(app.physical.get(3),/長押しで録音/);
});


test('full app retires a superseded runtime without changing shared pairing, consent or replacement resources', async t => {
  const credentials = {origin:'https://mac.tailtest.ts.net',token:'o'.repeat(43),resumeToken:'r'.repeat(43),appOrigin:'http://127.0.0.1:55895',expiresAt:Date.now()+100000};
  const app = await launch({nativePairing: credentials, request: (url, init) => {
    if (!url.endsWith('/api/pair/resume')) return;
    const runtime = JSON.parse(init.body).runtime;
    if (runtime.action === 'inspect') return Promise.resolve({status: 200, ok: true, json: async () => ({protocol: 1, generation: 0})});
    if (runtime.action === 'renew') return Promise.resolve({status: 409, ok: false, json: async () => ({code: 'runtime_superseded'})});
    return Promise.resolve({status: 200, ok: true, json: async () => ({...credentials, token: 'n'.repeat(43), protocol: 1, generation: 1})});
  }}); t.after(app.close);
  app.element('location-share').checked = true; await app.element('location-share').onchange(); await flush();
  app.element('transcript').value = 'Unsent draft';
  await app.element('record').click(); await flush();
  const native = [...app.nativeSaved], local = [...app.saved], count = app.calls.length;
  await assert.rejects(vm.runInContext('session.ensureOrigin(true)', app.context), /superseded/); await flush();
  assert.deepEqual([...app.nativeSaved], native); assert.deepEqual([...app.saved], local);
  assert.equal(app.element('transcript').value, 'Unsent draft'); assert.equal(app.element('transcript').readOnly, true);
  assert.equal(app.element('record').disabled, true);
  assert.match(app.element('dot-status').textContent, /引き継ぎ/);
  assert.equal(app.calls.slice(count).some(c => ['mic', 'imu', 'text', 'location-stop', 'location-api'].includes(c[0])), false);
  await app.emit(doubleTap); await app.advance(30000); await app.close();
  assert.equal(app.calls.slice(count).some(c => ['mic', 'imu', 'text', 'location-stop', 'location-api', 'exit'].includes(c[0])), false);
});


test('hidden app recovers after offline without relying on an online or foreground event', async t => {
  const app = await launch(); t.after(app.close);
  app.context.document.hidden = true; await app.browserEvent('visibilitychange');
  await app.browserEvent('offline');
  assert.equal(vm.runInContext('progress.connection', app.context), 'offline');
  await app.failUpdate();
  await new Promise(resolve => setTimeout(resolve, 1100)); await flush();
  await app.deliver(app.snapshot([proactive('background-recovered')]));
  assert.equal(vm.runInContext('progress.connection', app.context), 'online');
  assert.match(app.physical.get(2), /background-recovered/);
  assert.equal(app.context.document.hidden, true);
});


test('explicit disconnect stops a busy session before the revoke response and cannot erase a new pairing', async t => {
 const credentials={origin:'https://mac.tailtest.ts.net',token:'a'.repeat(43),resumeToken:'b'.repeat(43),expiresAt:Date.now()+100000};
 let reply;
 const app=await launch({nativePairing:credentials,request:url=>url.endsWith('/api/pair/revoke') ? new Promise(resolve=>{reply=resolve;}) : undefined});
 t.after(app.close);
 await app.evaluate('busy=true;');
 const before=app.networkCalls.filter(url=>url.endsWith('/api/pair/resume')).length;
 app.element('forget-pairing').click(); await flush();
 assert.equal(vm.runInContext('session.token',app.context),'');
 assert.equal(vm.runInContext('busy',app.context),false);
 assert.equal(app.element('forget-pairing').hidden,true);
 assert.equal(app.element('mac-setup').open,true);
 assert.match(app.element('pair-notice').textContent,/自動で完了/);
 assert.equal(app.networkCalls.filter(url=>url.endsWith('/api/pair/resume')).length,before,'disconnect never resumes');
 assert.equal(JSON.parse(app.nativeSaved.get('dot-disconnect-v1')).pending.length,1);
 await app.evaluate(`connectionTransitions.paired(${JSON.stringify({...credentials,token:'c'.repeat(43),resumeToken:'d'.repeat(43)})}); showSetup(false);`);
 reply({status:204,ok:true}); await flush();
 assert.equal(vm.runInContext('session.credentials.resumeToken',app.context),'d'.repeat(43));
 assert.equal(JSON.parse(app.nativeSaved.get('dot-relay-native-v1')).resumeToken,'d'.repeat(43));
});

test('reopening with durable disconnect intent suppresses stale native pairing and retries only revocation', async t => {
 const credentials={origin:'https://mac.tailtest.ts.net',token:'a'.repeat(43),resumeToken:'b'.repeat(43),expiresAt:Date.now()+100000};
 const app=await launch({nativePairing:credentials,skipInitialUpdate:true,
  nativeState:[['dot-disconnect-v1',JSON.stringify({version:1,pending:[credentials]})]],
  request:url=>url.endsWith('/api/pair/revoke') ? Promise.resolve({status:204,ok:true}) : undefined});
 t.after(app.close);
 await flush();
 assert.equal(vm.runInContext('session.token',app.context),'');
 assert.equal(app.networkCalls.some(url=>/pair\/resume|api\/updates/.test(url)),false);
 assert.equal(app.element('forget-pairing').hidden,true);
 assert.equal(app.element('mac-setup').open,true);
 assert.equal(app.element('pair-notice').textContent,'接続を解除しました。');
});

test('offline disconnect with a native storage failure remains stopped and reports that durability failed', async t => {
 const credentials={origin:'https://mac.tailtest.ts.net',token:'a'.repeat(43),resumeToken:'b'.repeat(43),expiresAt:Date.now()+100000};
 const app=await launch({nativePairing:credentials,nativeWrite:key=>key==='dot-disconnect-v1' ? false : true,
  request:url=>url.endsWith('/api/pair/revoke') ? Promise.reject(new Error('offline')) : undefined});
 t.after(app.close);
 app.element('forget-pairing').click(); await flush();
 assert.equal(vm.runInContext('session.token',app.context),'');
 assert.match(app.element('pair-notice').textContent,/解除を保存できません/);
 assert.equal(JSON.parse(app.nativeSaved.get('dot-relay-native-v1')).resumeToken,credentials.resumeToken,'retry proof is not discarded before intent is durable');
 assert.equal(vm.runInContext('disconnectJournal.pending.length',app.context),1);
});

test('disconnect during recording closes the microphone and discards speech without transcription', async t => {
 const credentials={origin:'https://mac.tailtest.ts.net',token:'a'.repeat(43),resumeToken:'b'.repeat(43),expiresAt:Date.now()+100000};
 const app=await launch({nativePairing:credentials,request:url=>url.endsWith('/api/pair/revoke') ? Promise.reject(new Error('offline')) : undefined});
 t.after(app.close);
 await app.element('record').click(); await flush();
 assert.equal(vm.runInContext('recorder.state',app.context),'recording');
 app.element('forget-pairing').click(); await flush();
 assert.equal(vm.runInContext('recorder.state',app.context),'idle');
 assert.equal(app.calls.filter(call=>call[0]==='mic').at(-1)[1],false);
 assert.equal(app.networkCalls.some(url=>/api\/(transcribe|utterances)$/.test(url)),false);
});

test('a failed journal restore blocks data access and retries restoration after a short backoff', async t => {
 const credentials={origin:'https://mac.tailtest.ts.net',token:'a'.repeat(43),resumeToken:'b'.repeat(43),expiresAt:Date.now()+100000};
 let failed=true;
 const app=await launch({nativePairing:credentials,skipInitialUpdate:true,nativeRead:key=>{
  if (key==='dot-disconnect-v1' && failed) throw new Error('storage unavailable');
 }});
 t.after(app.close);
 assert.equal(vm.runInContext('progress.connection',app.context),'connecting');
 assert.equal(app.networkCalls.length,0);
 assert.match(app.element('pair-notice').textContent,/復元せずに再確認/);
 failed=false; await app.advance(2000);
 await app.deliver(app.snapshot());
 assert.equal(vm.runInContext('session.credentials.resumeToken',app.context),credentials.resumeToken);
});


test('a transient journal read failure preserves legacy credentials and resumes the suspended receive loop', async t => {
 let failed=true;
 const app=await launch({skipInitialUpdate:true,nativeRead:key=>{ if(key==='dot-disconnect-v1' && failed) throw new Error('read failed'); }});
 t.after(app.close);
 assert.equal(vm.runInContext('session.token',app.context),'x'.repeat(43));
 assert.equal(vm.runInContext('progress.connection',app.context),'connecting');
 assert.equal(app.element('forget-pairing').hidden,false);
 failed=false; await app.advance(2000);
 // Discard the response for the pre-suspension request, then deliver the new loop.
 await app.deliver(app.snapshot()); await app.deliver(app.snapshot());
 assert.equal(vm.runInContext('progress.connection',app.context),'online');
});
