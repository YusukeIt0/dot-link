import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { bearingCandidates } from './bearing.js';

const $ = id => document.getElementById(id);
const pref = new URLSearchParams(window.location.search).get('lang') ?? import.meta.env?.VITE_PROBE_LANGUAGE ?? navigator.language;
const ja = pref.toLowerCase().startsWith('ja');
const label = (english, japanese) => ja ? japanese : english;
if (ja) {
  document.documentElement.lang = 'ja';
  for (const element of document.querySelectorAll('[data-ja]')) element.textContent = element.dataset.ja;
  document.title = document.querySelector('h1').textContent;
  $('result').setAttribute('aria-label', '観測結果');
}

let bridge;
let begin;
let timer;
let off;
let done = false;
const limitMs = 60000;
const observation = { sdk: '0.0.16', hostEvents: 0, imuReports: 0, candidateEvents: 0, lifecycle: [], values: [],
  mapAtStart: 'unconfirmed', mapAtEnd: 'unconfirmed' };
function showResult() {
  const askAboutMap = observation.mapAtStart === 'visible' && observation.mapAtEnd === 'unconfirmed';
  $('start').hidden = true;
  $('gone').hidden = $('finish').hidden = !askAboutMap;
  $('result').hidden = false;
  $('result').value = JSON.stringify(observation);
  $('status').textContent = label(
    `Finished. SDK events: ${observation.hostEvents}. Bearing candidates: ${observation.candidateEvents}.`,
    `終了しました。受け取った通知は${observation.hostEvents}件、方位の候補は${observation.candidateEvents}件です。`)
    + (askAboutMap ? label(' Did the map stay visible?', ' 地図がずっと見えていたか、下のボタンを押してください。') : '');
}
function end(reason) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  off?.();
  observation.elapsedMs = begin === undefined ? 0 : Math.max(0, Date.now() - begin);
  observation.reason = reason;
  showResult();
}
function checkDeadline() {
  if (begin === undefined || done) return false;
  const elapsed = Date.now() - begin;
  if (elapsed < 0 || elapsed >= limitMs) { end('time limit or clock changed'); return false; }
  return true;
}
function eventReceived(event) {
  if (!checkDeadline()) return;
  observation.hostEvents++;
  const tMs = Date.now() - begin;
  const type = event.sysEvent?.eventType;
  if (type === OsEventTypeList.IMU_DATA_REPORT || event.sysEvent?.imuData) observation.imuReports++;
  if ([OsEventTypeList.FOREGROUND_ENTER_EVENT, OsEventTypeList.FOREGROUND_EXIT_EVENT,
    OsEventTypeList.SYSTEM_EXIT_EVENT, OsEventTypeList.ABNORMAL_EXIT_EVENT].includes(type)) {
    if (observation.lifecycle.length < 24) observation.lifecycle.push({ tMs, type });
  }
  const fields = bearingCandidates(event.jsonData);
  if (Object.keys(fields).length > 0) {
    observation.candidateEvents++;
    if (observation.values.length < 120) observation.values.push({ tMs, fields });
  }
  if (type === OsEventTypeList.SYSTEM_EXIT_EVENT || type === OsEventTypeList.ABNORMAL_EXIT_EVENT) end('host exit');
}
function reportMap(state) {
  if (observation.mapAtEnd !== 'unconfirmed') return;
  observation.mapAtEnd = state;
  if (done) showResult();
  else end('wearer finished');
}
$('gone').onclick = () => reportMap('disappeared');
$('finish').onclick = () => reportMap('stayed visible');
$('start').onclick = () => {
  if (!bridge || done || begin !== undefined) return;
  begin = Date.now();
  observation.mapAtStart = 'visible';
  $('start').hidden = true;
  $('finish').hidden = false;
  try { off = bridge.onEvenHubEvent(eventReceived); } catch { end('listener unavailable'); return; }
  if (done) { off?.(); return; }
  timer = setTimeout(() => end('time limit'), limitMs);
  $('status').textContent = label('Listening. Keep the phone still and turn left and right.',
    '観測中です。スマホを置いたまま、ゆっくり左・右を向いてください。');
};
document.addEventListener('visibilitychange', () => {
  if (checkDeadline() && observation.lifecycle.length < 24) {
    observation.lifecycle.push({ tMs: Date.now() - begin, page: document.hidden ? 'hidden' : 'visible' });
  }
});
window.addEventListener('pagehide', () => { if (begin !== undefined) end('page closed'); });

try {
  bridge = await waitForEvenAppBridge();
  const device = await bridge.getDeviceInfo();
  if (!done && device?.model === 'g2' && device.status?.isConnected()) {
    $('start').disabled = false;
    $('status').textContent = label('G2 connected. Check whether the map is still on the glasses.',
      'G2につながりました。眼鏡にナビの地図が残っているか確認してください。');
  } else if (!done) {
    $('status').textContent = label('A connected G2 could not be confirmed.', 'G2の接続を確認できませんでした。');
  }
} catch {
  if (!done) $('status').textContent = label('The Even bridge is unavailable.', 'Evenとの接続を確認できませんでした。');
}
