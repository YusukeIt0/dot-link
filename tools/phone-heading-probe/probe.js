import { AppLocationAccuracy, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { exportPoses, phoneAngles, readFix, summary } from './angles.js';

const $ = id => document.getElementById(id);
const en = new URLSearchParams(window.location.search).get('lang') === 'en';
const say = (ja, english) => en ? english : ja;
if (en) {
  document.documentElement.lang = 'en';
  for (const el of document.querySelectorAll('[data-en]')) el.textContent = el.dataset.en;
  document.title = document.querySelector('h1').textContent;
  $('result').setAttribute('aria-label', 'Measurement result');
}
const clock = () => performance.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeoutSymbol = Symbol('timeout');
async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(timeoutSymbol), ms); })]);
  } finally { clearTimeout(timer); }
}

let bridge;
let bridgeState = 'not detected';
let permission = 'not requested';
let active = false, done = false, reading = false;
let safetyTimer;
let lastStamp = null;
let phaseEnd = -1;
let current = null;
const recent = {};
const poses = [];
const events = { orientation: 0, absolute: 0, relativeAlpha: 0, invalidCompassAccuracy: 0 };
let nativeHost = false;
function detectBridge() {
  if (nativeHost || typeof window.flutter_inappwebview?.callHandler !== 'function' || done) return;
  nativeHost = true;
  bridgeState = 'pending';
  void bounded(waitForEvenAppBridge(), 7000).then(value => {
    if (value === timeoutSymbol) bridgeState = 'bridge timeout';
    else { bridge = value; bridgeState = typeof bridge?.getAppLocation === 'function' ? 'ready' : 'location unavailable'; }
  }).catch(() => { bridgeState = 'bridge unavailable'; });
}
detectBridge();
window.addEventListener('flutterInAppWebViewPlatformReady', detectBridge);

function onOrientation(event) {
  if (!active || done) return;
  if (event.type === 'deviceorientationabsolute') events.absolute++;
  else events.orientation++;
  if (event.absolute !== true && event.type !== 'deviceorientationabsolute' && Number.isFinite(event.alpha)) events.relativeAlpha++;
  if (Number.isFinite(event.webkitCompassAccuracy) && event.webkitCompassAccuracy < 0) events.invalidCompassAccuracy++;
  const time = clock();
  for (const [source, value] of Object.entries(phoneAngles(event))) {
    recent[source] = { ...value, time };
    if (current && time >= current.from && time <= current.to && current[source].length < 350) current[source].push(value);
  }
}

async function locationFix() {
  const empty = state => ({ state, sample: null, stamp: null, ageMs: null });
  try {
    detectBridge();
    // A one-shot request cannot start or stop the companion's location stream.
    if (bridgeState === 'pending') {
      for (let i = 0; i < 10 && bridgeState === 'pending' && !done; i++) await pause(150);
    }
    if (done || bridgeState !== 'ready') return empty(bridgeState);
    const result = await bounded(bridge.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: 5000 }), 6000);
    return result === timeoutSymbol ? empty('request timed out') : readFix(result, Date.now());
  } catch { return empty('request failed'); }
}

function finish(reason) {
  if (done) return;
  done = true;
  active = false;
  current = null;
  clearTimeout(safetyTimer);
  window.removeEventListener('deviceorientation', onOrientation);
  window.removeEventListener('deviceorientationabsolute', onOrientation);
  window.removeEventListener('flutterInAppWebViewPlatformReady', detectBridge);
  $('measure').hidden = $('stop').hidden = true;
  $('result').value = JSON.stringify({ kind: 'phone-heading-probe-v1', sdk: '0.0.16', reason,
    secure: window.isSecureContext === true, nativeHost, bridgeState, permission, events,
    poses: poses.map(({ fix, webWindow }) => ({ fix, webWindow })), sources: exportPoses(poses) });
  $('result').hidden = $('copy').hidden = false;
  $('status').textContent = reason === 'completed' ? say('3回の測定が終わりました。「結果をコピー」を押してください。',
    'All three positions are recorded. Tap Copy result.') : say('測定を終了しました。途中までの結果をコピーできます。','Stopped. You can copy the partial result.');
  // Absolute bearings have no further use once the relative report is ready.
  poses.length = 0;
  for (const key of Object.keys(recent)) delete recent[key];
}

async function measure() {
  if (reading || done) return;
  reading = true;
  $('measure').disabled = true;
  if (!active) {
    active = true;
    $('stop').hidden = false;
    safetyTimer = setTimeout(() => finish('time limit'), 180000);
    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('deviceorientationabsolute', onOrientation);
    try {
      const type = window.DeviceOrientationEvent;
      // iOS requires the permission request in this button's user gesture.
      permission = typeof type?.requestPermission === 'function' ? await type.requestPermission()
        : type ? 'no prompt API' : 'API absent';
    } catch { permission = 'request failed'; }
  }
  if (done) return;
  $('status').textContent = say('その向きのままお待ちください。', 'Hold this position.');
  const tapped = clock();
  const hold = { from: tapped + 300, to: tapped + 1900, webkitCompass: [], flatAbsoluteAlpha: [] };
  current = hold;
  const [fix] = await Promise.all([locationFix(), pause(1950)]);
  if (done) return;
  current = null;
  const sources = { evenLocation: summary(fix.sample ? [fix.sample] : []) };
  const webWindow = {};
  for (const s of ['webkitCompass', 'flatAbsoluteAlpha']) {
    const last = recent[s];
    // A stationary browser may emit on change only. Use a recent event from
    // this pose only, never a sample left over from a previous marked position.
    const recentAtPose = last && last.time > phaseEnd && last.time >= tapped - 2000 && last.time <= clock();
    const fallback = !hold[s].length && recentAtPose;
    sources[s] = summary(fallback ? [last] : hold[s]);
    webWindow[s] = fallback ? 'recent at pose' : hold[s].length ? 'during hold' : 'no sample';
  }
  poses.push({ sources, webWindow, fix: { state: fix.state, ageMs: fix.ageMs,
    reused: fix.stamp !== null && fix.stamp === lastStamp } });
  if (fix.stamp !== null) lastStamp = fix.stamp;
  phaseEnd = clock();
  if (poses.length === 3) { finish('completed'); return; }
  reading = false;
  $('measure').disabled = false;
  $('measure').textContent = say('この向きで測る','Measure this position');
  $('status').textContent = poses.length === 1
    ? say('2 / 3　画面を上にしたまま、スマホの上端を右へ90度（時計回り）向けてください。置いたらボタンを押します。',
      '2 of 3. With the screen facing up, turn the top a quarter turn clockwise, then tap Measure.')
    : say('3 / 3　スマホの上端を、最初に覚えた向きへ戻してください。置いたらボタンを押します。',
      '3 of 3. Turn the top back to the starting direction, then tap Measure.');
}
$('measure').onclick = () => { void measure().catch(() => finish('measurement failed')); };
$('stop').onclick = () => finish('operator stopped');
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('result').value);
    $('status').textContent = say('コピーしました。','Copied.');
  } catch {
    $('result').focus(); $('result').select();
    $('status').textContent = say('結果を選択しました。表示されたメニューの「コピー」を押してください。','Result selected. Choose Copy from the menu.');
  }
};
window.addEventListener('pagehide', () => { if (active) finish('page closed'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && active) finish('page hidden'); });
