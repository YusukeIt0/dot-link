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
  .replace('import.meta.env.VITE_APP_VERSION', "'test'"));
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

async function launch(options = {}) {
  let now = 0, timerId = 0, receiver;
  const epoch = Date.now();
  const timers = new Map(); const elements = new Map(); const listeners = new Map();
  const calls = []; const networkCalls = []; const requests = []; const physical = new Map();
  const saved = new Map(options.nativePairing ? [] : [['g2-device-token', 'x'.repeat(43)]]);
  const nativeSaved = new Map(options.nativePairing ? [['dot-relay-native-v1', JSON.stringify(options.nativePairing)]] : []);
  if (options.savedLanguage) saved.set('dot-language', options.savedLanguage);
  if (options.nativeLanguage) nativeSaved.set('dot-language-preference-v1', options.nativeLanguage);
  let resumeAttempts = 0;
  let writeGate;
  const schedule = (callback, ms, repeat = false) => {
    const id = ++timerId; timers.set(id, { callback, at: now + ms, ms, repeat }); return id;
  };
  const clock = {now: () => now, schedule, cancel: id => timers.delete(id)};
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent: '', value: '', dataset: {}, checked: false, disabled: false,
      before() {}, after() {}, setAttribute() {}, removeAttribute() {}, focus() {}, addEventListener() {}, close() {}, pause() {}, showModal() {},
      click() { return this.onclick?.(); }});
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
    async audioControl(open) { calls.push(['mic', open]); return true; },
    async imuControl(open) { calls.push(['imu', open]); return true; },
    async shutDownPageContainer(mode) { calls.push(['exit', mode]); return true; },
    async getLocalStorage(k) { return nativeSaved.get(k) ?? ''; },
    async setLocalStorage(k, v) { const result = await (options.nativeWrite?.(k, v) ?? true); if (result) nativeSaved.set(k, v); return result; },
    onAppLocationChanged() { return () => {}; },
    async startAppLocationUpdates() { calls.push(['location-start']); return true; },
    async stopAppLocationUpdates() { calls.push(['location-stop']); return true; },
    async getAppLocation() { return {latitude: 10, longitude: 20, accuracy: 5, timestamp: Date.now()}; },
  };
  const staticLabel = element('static-test-label'); staticLabel.textContent = '表示設定'; staticLabel.dataset.en = 'Display settings';
  const local = {getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k)};
  const context = vm.createContext({ ...dependencies,
    // This harness models G2 lifecycle, not DOM geometry; viewport behavior has its own tests.
    installKeyboardViewport: () => () => {},
    InteractionStatus: class extends dependencies.InteractionStatus { constructor() { super(() => now); } },
    Date: class extends Date { static now() { return epoch + now; } },
    DisplayStandby: class extends dependencies.DisplayStandby { constructor(p, changed) { super(p, changed, clock); } },
    waitForEvenAppBridge: async () => bridge,
    document: {documentElement: {}, body: {dataset: {}}, hidden: false, getElementById: element,
      querySelector: element, querySelectorAll: () => [staticLabel], createComment: element, addEventListener: listen},
    window: {addEventListener: listen, speechSynthesis: {cancel() {}, speak() {}}},
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    navigator: {language: options.language ?? 'ja', userAgent: options.userAgent ?? 'iPhone', maxTouchPoints: 5},
    localStorage: local, sessionStorage: local, location: {origin: options.nativePairing ? 'http://127.0.0.1:57157' : 'https://test.invalid', hash: '', pathname: '/', search: ''},
    history: {replaceState() {}}, performance: {now: () => now}, crypto, console, URLSearchParams, AbortController, AbortSignal, Uint8Array, Blob, TextEncoder,
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
    fetch: (url, init) => {
      networkCalls.push(String(url));
      if (String(url).includes('/api/location/')) {
        calls.push(['location-api', String(url), JSON.parse(init.body)]);
        return Promise.resolve({status: 200, ok: true, json: async () => ({locationSharing: true, locationFresh: true})});
      }
      if (options.typedInput && String(url).endsWith('/api/utterances')) {
        const value = JSON.parse(init.body);
        return Promise.resolve({status: 200, ok: true, json: async () => ({...value, status: 'accepted', createdAt:new Date(epoch + now).toISOString()})});
      }
      if (String(url).endsWith('/api/pair/resume')) {
        resumeAttempts++;
        assert.equal(JSON.parse(init.body).resumeToken, options.nativePairing.resumeToken);
        calls.push(['resume']);
        if (options.failResumeOnce && resumeAttempts === 1) return Promise.reject(new Error('Temporary offline'));
        return Promise.resolve({status:200,ok:true,json:async()=>({...options.nativePairing,token:'n'.repeat(43)})});
      }
      if (String(url).endsWith('/api/timings')) return Promise.resolve({status: 204, ok: true});
      assert.equal(url, options.nativePairing ? `${options.nativePairing.origin}/api/updates` : '/api/updates', 'fixture must never access another API');
      if (options.nativePairing) assert.equal(init.headers.Authorization, `Bearer ${'n'.repeat(43)}`, 'only resumed token reaches data API');
      return new Promise(resolve => requests.push(resolve));
    },
  });
  vm.runInContext(script, context); await flush();
  assert.equal(element('g2-diagnostic').textContent, 'G2_READY');
  const snapshot = (messages = []) => ({revision: 'same', status: {subscribed: true, deviceName: 'Test Mac', sttProvider: options.provider}, messages});
  const deliver = async value => {
    assert.ok(requests.length, 'receiver must still be waiting');
    requests.shift()({ok: true, status: 200, json: async () => structuredClone(value)}); await flush();
  };
  if (!options.failResumeOnce) await deliver(snapshot(options.initialMessages ?? []));
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
    await app.evaluate(`progress.begin('job', 'recognizing'); progress.setPhase('${phase}'); progress.connection='offline'; refreshStatus();`);
    await app.advance(90_000); assert.equal(app.hidden(), false);
  }
  await app.evaluate("progress.waiting('job'); refreshStatus();");
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
  await app.evaluate("progress.connection = 'offline'; refreshStatus()");
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
  for (const locale of ['en', 'ja', 'en']) {
    app.element('language').value = locale; app.element('language').onchange(); await flush();
    assert.equal(app.context.document.documentElement.lang, locale);
    assert.equal(app.element('static-test-label').textContent, locale === 'en' ? 'Display settings' : '表示設定');
    assert.match(app.element('tts').textContent, /ON$/);
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
  const stored = vm.runInContext('JSON.parse(JSON.stringify(messages))',app.context);
  const message = stored[0];
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
  await app.evaluate('document.hidden = true; pageActive = false; refreshStatus();');
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
