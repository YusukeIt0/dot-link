import {
  CreateStartUpPageContainer, ImuReportPace, OsEventTypeList, TextContainerProperty,
  TextContainerUpgrade, waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { hostMotion, limits, numericAxis, poses, summarize } from './measurement.js';

const $ = id => document.getElementById(id);
const requestedLanguage = new URLSearchParams(window.location?.search).get('lang');
const japanese = (requestedLanguage ?? import.meta.env?.VITE_PROBE_LANGUAGE ?? navigator.language).toLowerCase().startsWith('ja');
const say = (english, ja) => japanese ? ja : english;
const poseText = index => poses[index][japanese ? 2 : 1];
if (japanese) {
  document.documentElement.lang = 'ja';
  document.title = $('title').textContent = 'G2の向きの測定 · Beta';
  $('language').textContent = 'English';
  $('language').href = '?lang=en';
  $('instructions').textContent = 'スマホを机に置き、好きな方向を正面にしてください。眼鏡の表示に合わせて、顔を水平にしたまま体ごと回ります。向きを合わせたら眼鏡かリングを1回タップし、次の表示までじっとします。';
  $('privacy').textContent = '測定値はこの画面にだけ残ります。測定は最長4分で終わります。';
  $('start').textContent = '測定を始める';
  $('mark').textContent = '向きを合わせた';
  $('stop').textContent = '測定を止める';
  $('export-label').textContent = '測定記録（画面を閉じる前にコピーできます）';
  $('select').textContent = '測定記録を選択';
  $('status').textContent = 'G2に接続しています…';
}
const page = { containerID: 1, containerName: 'probe' };
let bridge;
let active = false;
let phase = 'idle';
let position = 0;
let startedAt = 0;
let clock;
let timeout;
let unsubscribeEvents;
let unsubscribeDevice;
let rows = [];
let marks = [];
let model = null;
let glassesId;
let displayWrites = Promise.resolve();
let imuStart;
let startPending = false;
let imuOff;
let finishPromise;
const expectedInterval = ImuReportPace.P200;

function show(text) {
  $('status').textContent = text;
  if (!bridge) return;
  displayWrites = displayWrites.then(() => bridge.textContainerUpgrade(new TextContainerUpgrade({
    ...page, contentOffset: 0, contentLength: text.length, content: text,
  }))).catch(() => {});
}

function nextPose() {
  phase = 'move';
  $('mark').disabled = false;
  show(`${position + 1}/${poses.length}  ${poseText(position)}\n${say('Tap once when aligned. Hold for the next pose.', '向いたら1回タップ。次の表示までそのまま。')}`);
}

function markPose() {
  if (!active || phase !== 'move') return;
  $('mark').disabled = true;
  phase = 'settle';
  marks.push({ pose: poses[position][0], alignedMs: Math.round(performance.now() - startedAt) });
  show(say('Hold still', 'そのまま、動かずに待つ'));
  clock = setTimeout(() => {
    phase = 'hold';
    clock = setTimeout(() => {
      position++;
      if (position === poses.length) void finish('all poses marked');
      else nextPose();
    }, limits.holdMs);
  }, limits.settleMs);
}

function receive(event) {
  if (!active) return;
  const sys = event.sysEvent;
  const type = sys?.eventType ?? event.textEvent?.eventType;
  if ([OsEventTypeList.SYSTEM_EXIT_EVENT, OsEventTypeList.ABNORMAL_EXIT_EVENT,
    OsEventTypeList.FOREGROUND_EXIT_EVENT].includes(type)) { void finish('host exited'); return; }
  const extra = hostMotion(event.jsonData);
  const hasExtra = Object.keys(extra).length > 0;
  if (sys?.imuData || type === OsEventTypeList.IMU_DATA_REPORT || hasExtra) {
    const imu = sys?.imuData ?? {};
    rows.push({ tMs: Math.round(performance.now() - startedAt), pose: poses[position][0],
      phase, x: numericAxis(imu.x), y: numericAxis(imu.y), z: numericAxis(imu.z),
      ...(hasExtra ? { hostMotion: extra } : {}) });
    if (rows.length >= limits.samples) void finish('sample limit');
    return;
  }
  // The host can omit CLICK_EVENT, whose protobuf value is zero, on captured text.
  if (type === OsEventTypeList.CLICK_EVENT || (event.textEvent && type === undefined)) markPose();
}

function renderResults(reason) {
  const summary = summarize(rows);
  $('summary').textContent = summary.map(({pose, complete, received, means}) =>
    `${pose}  ${complete}/${received} XYZ  ${means.x ?? '?'}  ${means.y ?? '?'}  ${means.z ?? '?'}   |v| ${means.magnitude ?? '?'}`).join('\n');
  $('data').value = JSON.stringify({ sdk: '0.0.16', model, pace: 'P200', timing: 'host receipt ms since start',
    reference: 'initial forward, geographic direction unknown unless independently documented',
    stopReason: reason, imuOffAcknowledged: imuOff ?? null, marks, summary, rows });
  $('export').hidden = false;
  const count = summary.filter(s => s.complete > 0).length;
  return say(`Stopped · ${reason}. ${rows.length} reports. ${count}/${poses.length} poses have complete XYZ.`,
    `測定を終了しました。${count}/${poses.length}姿勢で3軸を記録（${rows.length}件）。この画面を開いたままにしてください。`);
}

async function disableImu(reason) {
  try { imuOff = await bridge.imuControl(false, expectedInterval) === true; } catch { imuOff = false; }
  renderResults(reason);
  if (!imuOff) $('status').textContent = say('Sampling stopped locally. Exit the preview to end the device session; IMU stop was not acknowledged.', '記録を停止しました。眼鏡からの停止確認がないため、記録をコピーしたらこの画面を終了してください。');
}

function finish(reason) {
  if (!active) return finishPromise;
  active = false;
  clearTimeout(clock);
  clearTimeout(timeout);
  unsubscribeEvents?.();
  unsubscribeDevice?.();
  $('mark').hidden = $('stop').hidden = true;
  // Show collected data even if the host disconnects before acknowledging stop.
  const message = renderResults(reason);
  $('status').textContent = message;
  if (!document.hidden && ['all poses marked', 'operator stopped', 'time limit', 'sample limit'].includes(reason)) show(message);
  finishPromise = disableImu(reason);
  // Request stop immediately even if the host has not answered the start call.
  // A late successful start gets another stop after the first one settles.
  if (startPending) Promise.resolve(imuStart).then(async enabled => {
    if (enabled === true) { await finishPromise; await disableImu(reason); }
  }).catch(() => {});
  return finishPromise;
}

async function start() {
  if (active || $('start').disabled) return;
  $('start').disabled = true;
  $('language').hidden = true;
  $('start').hidden = true;
  $('stop').hidden = false;
  active = true;
  phase = 'starting';
  startedAt = performance.now();
  timeout = setTimeout(() => { void finish('time limit'); }, limits.sessionMs);
  unsubscribeEvents = bridge.onEvenHubEvent(receive);
  unsubscribeDevice = bridge.onDeviceStatusChanged(status => {
    if (glassesId && status.sn && status.sn !== glassesId) return;
    if (status.isDisconnected() || status.isConnectionFailed() || status.isInCase === true)
      void finish('device disconnected or in case');
  });
  try {
    startPending = true;
    imuStart = bridge.imuControl(true, expectedInterval);
    const enabled = await imuStart;
    startPending = false;
    if (!active) return;
    if (enabled !== true) { await finish('IMU start rejected'); return; }
    $('mark').hidden = false;
    nextPose();
  } catch { startPending = false; await finish('IMU start failed'); }
}

$('start').onclick = () => { void start(); };
$('mark').onclick = markPose;
$('stop').onclick = () => { void finish('operator stopped'); };
$('select').onclick = () => { $('data').focus(); $('data').select(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) void finish('page hidden'); });
window.addEventListener('pagehide', () => { void finish('page closed'); });

async function initialize() {
  if (typeof window.flutter_inappwebview?.callHandler !== 'function') {
    $('status').textContent = say('Open this preview in the official Even app to measure.', '純正Evenアプリでこの画面を開いてください。');
  }
  try {
    bridge = await waitForEvenAppBridge();
    const device = await bridge.getDeviceInfo();
    model = device?.model ?? null;
    glassesId = device?.sn; // Only to ignore status updates for other devices. Never exported.
    if (model !== 'g2' || !device?.status?.isConnected()) {
      $('status').textContent = say('Connect G2 in the Even app, then reopen this preview.', 'EvenアプリでG2を接続し、この画面をもう一度開いてください。');
      return;
    }
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 1, textObject: [new TextContainerProperty({ ...page,
        xPosition: 8, yPosition: 48, width: 560, height: 152, isEventCapture: 1,
        content: say('G2 motion probe · Beta\nStart the measurement on the phone.', 'G2の向きの測定 · Beta\nスマホで「測定を始める」を押してください。') })],
    }));
    if (result !== 0) throw new Error();
    $('start').disabled = false;
    $('status').textContent = say('G2 ready. Set down the phone, then start.', 'G2につながりました。スマホを置いて「測定を始める」を押してください。');
  } catch { $('status').textContent = say('The Even bridge or glasses page did not start. Reopen the preview with G2 connected.', 'G2との接続を確認して、もう一度この画面を開いてください。'); }
}

void initialize();
