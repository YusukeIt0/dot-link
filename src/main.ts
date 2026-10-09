import { AudioInputSource, CreateStartUpPageContainer, ImuReportPace, OsEventTypeList, TextContainerProperty,
  TextContainerUpgrade, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Recorder } from './audio.ts';
import { TimingTracker } from './timing.ts';
import { LiveUpdates } from './live-updates.ts';
import { Pairing } from './pairing.ts';
import { InteractionStatus } from './interaction-status.ts';
import { DisplayStandby, HeadRaiseDetector, type DisplayPreferences } from './display-standby.ts';
import { DisplayPreferenceStore } from './display-preferences.ts';
import { t, getLanguage, setLanguage, chooseLanguage } from './i18n.ts';
import { RelaySettings, PendingUtterance, apiAddress, type RelayCredentials } from './relay-connection.ts';
import { parseInvite, type PairingInvite } from './relay-origin.ts';
import './style.css';

let savedLanguage: string | null = null;
try { savedLanguage = localStorage.getItem('dot-language'); } catch {}
setLanguage(chooseLanguage(navigator.language, savedLanguage));
document.documentElement.lang = getLanguage();
if (getLanguage() === 'en') {
  for (const element of document.querySelectorAll<HTMLElement>('[data-en]')) element.textContent = element.dataset.en!;
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const displayPreferences = new DisplayPreferenceStore(() => localStorage);
const headRaise = new HeadRaiseDetector(displayPreferences.value);
let standby: DisplayStandby | undefined;
el('app-version').textContent = `v${import.meta.env.VITE_APP_VERSION}`;
const connection = el('connection');
const notice = el('notice');
const recordButton = el<HTMLButtonElement>('record');
const discardButton = el<HTMLButtonElement>('discard');
const sendButton = el<HTMLButtonElement>('send');
const transcript = el<HTMLTextAreaElement>('transcript');
const pairingInput = el<HTMLTextAreaElement>('pair-code');
const relaySettings = new RelaySettings(() => localStorage);
let relay = relaySettings.read();
const pairing = new Pairing(() => localStorage, () => sessionStorage);
let token = relay?.token ?? pairing.read();
const setupPanel = el<HTMLDetailsElement>('pairing-settings');
let setupReady = !!token;
function showSetupStep(): void {
  el('setup-intro').hidden = setupReady;
  el('pairing-form').hidden = !setupReady;
}
el('setup-ready').onclick = () => { setupReady = true; showSetupStep(); };
el('setup-back').onclick = () => { setupReady = false; showSetupStep(); };
const setupHome = document.createComment('connection-settings');
setupPanel.before(setupHome);
const noticeHome = document.createComment('notice-home');
notice.before(noticeHome);
function showSetup(unpaired: boolean): void {
  document.body.dataset.pairState = unpaired ? 'unpaired' : 'paired';
  setupPanel.open = unpaired;
  if (!unpaired) setupReady = true;
  showSetupStep();
  el('forget-pairing').hidden = unpaired;
  el('pair').hidden = !offeredInvite;
  if (unpaired) {
    document.querySelector('header')!.after(setupPanel);
    el('pair-notice-slot').after(notice);
  } else {
    setupHome.after(setupPanel);
    noticeHome.after(notice);
  }
}
let pendingDelivery = new PendingUtterance(() => localStorage, relay?.origin ?? location.origin);
let connectionController = new AbortController();
let connectionVersion = 0;
let exited = false;
let glassesReady = false;
let startupStage: 'bridge' | 'page' | 'ready' = 'bridge';
let startupResult: number | undefined;
let offeredInvite: PairingInvite | undefined;
const pairingToken = new URLSearchParams(location.hash.slice(1)).get('pair');
if (!relay && pairingToken && /^[A-Za-z0-9_-]{43}$/.test(pairingToken)) {
  token = pairingToken; pairing.save(token);
  history.replaceState(null, '', location.pathname + location.search);
}
el('app-origin').textContent = location.origin;
el('show-diagnostics').onclick = () => {
  const details = el('connection-diagnostics'); details.hidden = !details.hidden;
  el('show-diagnostics').setAttribute('aria-expanded', String(!details.hidden));
};
const language = el<HTMLSelectElement>('language'); language.value = getLanguage();
if (getLanguage() === 'en') transcript.placeholder = 'Transcribed speech, or a message to send';
language.onchange = () => {
  if (busy || recorder.state !== 'idle') { language.value = getLanguage(); notice.textContent = t('処理が終わるまでお待ちください。'); return; }
  try { localStorage.setItem('dot-language', language.value); } catch {}
  location.reload();
};
const progress = new InteractionStatus();
progress.connection = token ? 'connecting' : 'unpaired';
let hostName = t('接続先');
let baseStatus = t('長押しで話してください');
let visibleMessageId: string | undefined;
let statusTimer: ReturnType<typeof setInterval> | undefined;
let statusQueued = false;
let statusDirty = false;
let lastSentStatus = '';
let pageActive = true;
function forgetPairing(message: string): void {
  updates.stop(); connectionController.abort(); connectionController = new AbortController(); connectionVersion++;
  token = ''; relay = undefined; relaySettings.forget(); pairing.forget(); pairingInput.value = ''; offeredInvite = undefined;
  showSetup(true);
  messages = []; spoken.clear(); historyIndex = -1; pendingHistoryDisplay = false;
  progress.connection = 'unpaired'; refreshStatus();
  el('dot-status').textContent = t('再接続が必要です'); notice.textContent = message;
  el<HTMLDetailsElement>('pairing-settings').open = true;
}
let busy = false;
let subscribed = false;
let tts = false;
let messages: Message[] = [];
let historyIndex = -1;
let pendingHistoryDisplay = false;
const spoken = new Set<string>();
const timing = new TimingTracker();
let audioTraceId: string | undefined;
const reportedDisplay = new Set<string>();
interface Message { id: string; text: string; reply?: string; status: string; kind?: 'notification' | 'proactive'; source_app?: string; }

let resumeFlight: Promise<void> | undefined;
async function ensureRelayOrigin(force = false): Promise<void> {
  if (!relay?.resumeToken || (!force && relay.appOrigin === location.origin)) return;
  if (resumeFlight) return resumeFlight;
  const saved = relay, version = connectionVersion;
  const attempt = (async () => {
    const response = await fetch(apiAddress('/api/pair/resume', saved.origin), {
      method: 'POST', credentials: 'omit', redirect: 'error', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({resumeToken: saved.resumeToken}),
      signal: AbortSignal.any([connectionController.signal, AbortSignal.timeout(15000)]),
    });
    if (version !== connectionVersion || exited) throw new Error('Connection changed');
    if (response.status === 401) { forgetPairing(t('接続の有効期限が切れたか、Mac側で解除されました。新しい接続コードで接続してください。')); throw new Error('Recovery rejected'); }
    if (!response.ok) throw new Error('Recovery unavailable');
    const renewed: RelayCredentials = {...await response.json(), origin: saved.origin, appOrigin: location.origin};
    if (version !== connectionVersion || exited) throw new Error('Connection changed');
    relaySettings.save(renewed); relay = renewed; token = renewed.token;
    void relaySettings.nativeSaved().then(ok => { if (!ok && version === connectionVersion && !exited) notice.textContent = t('Even側への接続情報の保存を確認できません。次回の更新時に再接続が必要な場合があります。'); });
  })();
  resumeFlight = attempt;
  try { await attempt; } finally { if (resumeFlight === attempt) resumeFlight = undefined; }
}
async function restoreRelay(appBridge: EvenAppBridge): Promise<void> {
  const version = connectionVersion;
  const saved = await relaySettings.attach(appBridge);
  if (version !== connectionVersion || exited) return;
  // Legacy development credentials are separate from packaged pairing.
  if (!saved && !relay) return;
  updates.stop(); connectionController.abort(); connectionController = new AbortController(); connectionVersion++;
  relay = saved; token = saved?.token ?? '';
  if (!saved) { showSetup(true); progress.connection = 'unpaired'; refreshStatus(); return; }
  pendingDelivery = new PendingUtterance(() => localStorage, saved.origin);
  showSetup(false); progress.connection = 'connecting'; refreshStatus();
  updates.start(true);
}

async function api<T>(path: string, method = 'GET', body?: string | Uint8Array, trace?: string, recovered = false): Promise<T> {
  const version = connectionVersion;
  await ensureRelayOrigin();
  if (version !== connectionVersion || exited) throw new Error('Connection changed');
  const response = await fetch(apiAddress(path, relay?.origin), { method, credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${token}`,
    ...(trace ? { 'X-G2-Trace-ID': trace } : {}),
    ...(body ? { 'Content-Type': typeof body === 'string' ? 'application/json' : 'audio/wav' } : {}) },
    body: body instanceof Uint8Array ? new Blob([new Uint8Array(body).buffer], {type:'audio/wav'}) : body,
    signal: AbortSignal.any([connectionController.signal, AbortSignal.timeout(path === '/api/transcribe' ? 100000 : 25000)]) });
  if (version !== connectionVersion || exited) throw new Error('Connection changed');
  if (response.status === 401 && relay?.resumeToken && !recovered) {
    await ensureRelayOrigin(true);
    return api<T>(path, method, body, trace, true);
  }
  if (response.status === 401) forgetPairing(t('接続設定が無効になりました。Macで新しい接続コードを発行してください。'));
  if (!response.ok) throw new Error(response.status === 401 ? t('Macで新しい接続コードを発行し、貼り付けてください。') : t('処理できませんでした。接続または録音を確認してください。'));
  return (response.status === 204 ? undefined : response.json()) as Promise<T>;
}

function reportTiming(id: string): void {
  const report = timing.report(id);
  if (report) void api('/api/timings', 'POST', JSON.stringify(report)).catch(() => {});
}

function showMessage(): void {
  const message = messages[historyIndex];
  if (message?.kind === 'proactive') { display(`Dot · ${historyIndex + 1}/${messages.length}`, message.reply ?? ''); return; }
  if (message) display(message.reply ? `Dot · ${historyIndex + 1}/${messages.length}` : message.status === 'failed' ? t('送信未確認') : t('Dotの返信待ち'), `${message.kind === 'notification' ? `${t('通知')} (${message.source_app ?? 'Mac'})` : t('あなた')}: ${message.text}\n\nDot: ${message.reply ?? (message.status === 'failed' ? t('配送を確認できませんでした') : t('返信を待っています…'))}`, message.reply ? message.id : undefined);
}
interface Snapshot { revision: string; status: { subscribed: boolean; deviceName?: string }; messages: Message[]; }
function receiveUpdate(snapshot: Snapshot, initial = false): void {
  if (exited) return;
  subscribed = snapshot.status.subscribed;
  progress.connection = 'online'; progress.dotConnected = subscribed;
  if (snapshot.status.deviceName) hostName = snapshot.status.deviceName;
  const next = snapshot.messages;
  for (const message of next) {
    if (!message.reply || spoken.has(message.id)) continue;
    progress.complete(message.id);
    spoken.add(message.id);
    if (!initial) standby?.activity();
    if (!initial) timing.mark(message.id, 'reply_received');
    if (!initial && tts && 'speechSynthesis' in window) {
      const speech = new SpeechSynthesisUtterance(message.reply); speech.lang = getLanguage() === 'ja' ? 'ja-JP' : 'en-US';
      speech.onerror = () => { notice.textContent = t('読み上げできませんでした。画面の返信をご確認ください。'); };
      window.speechSynthesis.speak(speech);
    }
  }
  const changed = JSON.stringify(messages) !== JSON.stringify(next);
  messages = next;
  while (spoken.size > 200) spoken.delete(spoken.values().next().value!);
  el('dot-status').textContent = `${hostName} · ${subscribed ? t('Dot接続済み') : t('Dot未接続')}`;
  if (changed) pendingHistoryDisplay = true;
  flushPendingDisplay();
  refreshStatus();
}
function flushPendingDisplay(): void {
  if (pendingHistoryDisplay && !busy && recorder.state === 'idle') {
    pendingHistoryDisplay = false; historyIndex = messages.length - 1; showMessage();
  }
  refreshStatus(false);
}

const updates = new LiveUpdates<Snapshot>(async (revision, signal) => {
  await ensureRelayOrigin();
  if (signal.aborted) throw new Error('Connection changed');
  const response = await fetch(apiAddress('/api/updates', relay?.origin), { credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(revision ? { 'X-G2-Revision': revision } : {}) },
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
  if (!signal.aborted && response.status === 401) {
    if (relay?.resumeToken) await ensureRelayOrigin(true);
    else forgetPairing(t('接続設定が無効になりました。Macで新しい接続コードを発行してください。'));
  }
  if (!response.ok) throw new Error('Update connection failed');
  return response.json() as Promise<Snapshot>;
}, receiveUpdate, () => {
  progress.connection = 'offline'; refreshStatus();
  el('dot-status').textContent = `${hostName} · ${t('再接続中')}`;
});

function offerInvite(raw: string): void {
  offeredInvite = parseInvite(raw);
  el('pair-destination').textContent = offeredInvite.origin;
  el('pair').hidden = false;
  notice.textContent = t('接続先を確認して「接続」を押してください。');
}
pairingInput.oninput = () => {
  offeredInvite = undefined; el('pair-destination').textContent = ''; el('pair').hidden = true;
  try { offerInvite(pairingInput.value); } catch { notice.textContent = t('接続コードが無効か期限切れです。Macで新しく発行してください。'); }
};
el('pair').onclick = async () => {
  if (busy || recorder.state !== 'idle' || exited) return;
  let invite: PairingInvite;
  try { invite = parseInvite(offeredInvite ? JSON.stringify(offeredInvite) : pairingInput.value); }
  catch { notice.textContent = getLanguage() === 'ja' ? 'Macで接続コードをコピーして、全体を貼り付けてください。' : 'Copy the pairing code on your Mac and paste the entire code here.'; return; }
  busy = true; const button = el<HTMLButtonElement>('pair'); button.disabled = true;
  updates.stop(); connectionController.abort(); connectionController = new AbortController(); connectionVersion++;
  const version = connectionVersion;
  progress.connection = 'connecting'; refreshStatus();
  try {
    const response = await fetch(apiAddress('/api/pair', invite.origin), { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invite.code }),
      signal: AbortSignal.any([connectionController.signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) throw new Error('Pairing failed');
    const credentials = { ...await response.json(), origin: invite.origin, appOrigin: location.origin };
    if (version !== connectionVersion || exited) return;
    const retained = relaySettings.save(credentials);
    relay = credentials; token = credentials.token; pairing.forget();
    pendingDelivery = new PendingUtterance(() => localStorage, relay!.origin);
    pendingId = undefined; pendingText = undefined;
    messages = []; spoken.clear(); historyIndex = -1;
    const snapshot = await api<Snapshot>('/api/updates'); receiveUpdate(snapshot, true); updates.start(false, snapshot.revision);
    pairingInput.value = ''; offeredInvite = undefined;
    const nativeRetained = await relaySettings.nativeSaved();
    if (version !== connectionVersion || exited) return;
    notice.textContent = nativeRetained && credentials.resumeToken ? t('接続しました。更新後の再接続情報も保存しました。') : retained ? t('接続しました。更新後の自動復元は未確認です。') : t('接続しました。この画面では設定を保存できないため、閉じた後は新しい接続コードで接続してください。');
    el('diagnostic').textContent = getLanguage() === 'ja' ? '接続確認成功' : 'Connection verified';
    showSetup(false);
  } catch (error) {
    if (version !== connectionVersion || exited) return;
    progress.connection = token ? 'offline' : 'unpaired'; refreshStatus();
    notice.textContent = t('Macが停止・スリープ・オフラインの場合は接続できません。');
    el('diagnostic').textContent = getLanguage() === 'ja' ? 'Tailscale接続、Macの状態、コードの期限を確認してください。' : 'Check Tailscale, your Mac, and code expiry.';
    if (token) updates.start(true);
  } finally { busy = false; button.disabled = false; flushPendingDisplay(); }
};
el('forget-pairing').onclick = async () => {
  if (busy || recorder.state !== 'idle') return;
  busy = true; let revoked = false;
  try { if (relay) { await api('/api/pair/revoke', 'POST'); revoked = true; } }
  catch {} finally {
    forgetPairing(revoked ? t('接続を解除しました。') : t('端末の設定を削除しました。Macに接続できなかったため、Mac側でも接続を解除してください。'));
    busy = false; display(t('接続設定が必要'), t('スマートフォンで接続設定を開いてください'));
  }
};
el('tts').onclick = () => {
  tts = !tts; el('tts').textContent = `${t('読み上げ')} ${tts ? 'ON' : 'OFF'}`;
  if (tts && 'speechSynthesis' in window) { const speech = new SpeechSynthesisUtterance(t('読み上げをオンにしました')); speech.lang = getLanguage() === 'ja' ? 'ja-JP' : 'en-US'; window.speechSynthesis.speak(speech); }
  else window.speechSynthesis?.cancel();
};
el('previous').onclick = () => { standby?.activity(); historyIndex = Math.max(0, historyIndex - 1); showMessage(); };
el('next').onclick = () => { standby?.activity(); historyIndex = Math.min(messages.length - 1, historyIndex + 1); showMessage(); };
let pendingId: string | undefined;
let pendingText: string | undefined;
sendButton.onclick = async () => {
  const text = transcript.value.trim(); if (!text || busy || !token || exited) return;
  standby?.activity();
  busy = true; sendButton.disabled = true;
  refreshStatus(false);
  const version = connectionVersion;
  try {
    if (pendingText !== text) { pendingId = await pendingDelivery.prepare(text, audioTraceId); pendingText = text; audioTraceId = undefined; }
    if (version !== connectionVersion || exited) return;
    progress.begin(pendingId!, 'sending'); refreshStatus();
    timing.mark(pendingId!, 'utterance_sent');
    const message = await api<Message>('/api/utterances', 'POST', JSON.stringify({id:pendingId,text}));
    timing.mark(pendingId!, 'utterance_accepted');
    reportTiming(pendingId!);
    if (message.status === 'failed') throw new Error(t('配送を確認できませんでした。同じ発話は重複送信しません。'));
    progress.waiting(message.id);
    pendingDelivery.clear();
    transcript.value = ''; pendingId = undefined; pendingText = undefined;
    const reply = message.reply ?? messages.find(item => item.id === message.id)?.reply;
    if (reply) { progress.complete(message.id); display('Dot', `${t('あなた')}: ${text}\n\nDot: ${reply}`, message.id); }
    else display(t('Dotの返信待ち'), t('返信を待っています…'));
    notice.textContent = '';
  } catch (error) {
    if (version !== connectionVersion || exited) return;
    progress.setPhase('error'); notice.textContent = (error as Error).message;
    display(t('送信を確認できませんでした'), (error as Error).message);
  }
  finally { busy = false; sendButton.disabled = !transcript.value.trim(); flushPendingDisplay(); }
};
transcript.oninput = () => { sendButton.disabled = busy || !transcript.value.trim(); };

let bridge: EvenAppBridge | undefined;
let clip: Uint8Array | undefined;
let displayChain = Promise.resolve();
let displayGeneration = 0;
let lastDisplayText = t('長押しで話してください');

// A timer updates only the short status line. Keep at most one queued update
// and read its latest value when it runs, so slow BLE never queues old seconds.
function refreshStatus(sendToG2 = true): void {
  if (exited) return;
  standby?.protect(busy || recorder.state !== 'idle' || ['recognizing', 'sending', 'waiting'].includes(progress.phase));
  const caption = progress.caption(baseStatus, visibleMessageId);
  el('hud-state').textContent = caption;
  el('hud-state').dataset.state = progress.state;
  const ticking = progress.ticking && pageActive && !document.hidden;
  if (ticking && !statusTimer) statusTimer = setInterval(() => refreshStatus(), 1000);
  else if (!ticking && statusTimer) { clearInterval(statusTimer); statusTimer = undefined; }
  if (!sendToG2 || standby?.hidden || !bridge || !glassesReady || caption === lastSentStatus) return;
  if (statusQueued) { statusDirty = true; return; }
  statusQueued = true;
  const activeBridge = bridge;
  displayChain = displayChain.then(async () => {
    if (exited || standby?.hidden) return;
    const content = progress.caption(baseStatus, visibleMessageId);
    if (content === lastSentStatus) return;
    const ok = await activeBridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: 1, containerName: 'status', contentOffset: 0, contentLength: content.length, content,
    }));
    if (!ok) throw new Error('Status update failed');
    lastSentStatus = content;
  }).catch(() => {
    connection.textContent = t('G2の表示更新を確認できません');
  }).finally(() => {
    statusQueued = false;
    if (statusDirty) { statusDirty = false; refreshStatus(); }
  });
}

function display(state: string, text: string, trace?: string): void {
  if (exited) return;
  baseStatus = state; visibleMessageId = trace;
  if (trace && !timing.report(trace)) trace = undefined;
  refreshStatus(false);
  el('hud-content').textContent = text;
  lastDisplayText = text;
  queueDisplayFrame(trace);
}

// Blanking and normal frames share the same serial BLE queue. If a newer frame
// wins while a write is in flight, stop the old frame before its next container.
function queueDisplayFrame(trace?: string): void {
  if (!bridge || !glassesReady) return;
  const activeBridge = bridge;
  const generation = ++displayGeneration;
  displayChain = displayChain.then(async () => {
    if (exited || generation !== displayGeneration) return;
    if (trace) timing.mark(trace, 'g2_update_started');
    const hidden = standby?.hidden ?? false;
    const caption = hidden ? ' ' : progress.caption(baseStatus, visibleMessageId);
    const text = hidden ? ' ' : lastDisplayText;
    const help = hidden ? ' ' : t('長押しで録音 · 指を離すと停止');
    for (const [containerID, containerName, content] of [[1, 'status', caption], [2, 'conversation', text || ' '], [3, 'help', help]] as const) {
      if (exited || generation !== displayGeneration) return;
      const ok = await activeBridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID, containerName, contentOffset: 0, contentLength: content.length, content,
      }));
      if (!ok) throw new Error('G2表示の更新を確認できませんでした');
      if (containerID === 1) lastSentStatus = content;
    }
    if (!hidden && trace && generation === displayGeneration && !reportedDisplay.has(trace)) {
      timing.mark(trace, 'g2_update_ack'); reportedDisplay.add(trace); reportTiming(trace);
      if (reportedDisplay.size > 100) reportedDisplay.delete(reportedDisplay.values().next().value!);
    }
  }).catch(() => {
    if (trace) { timing.mark(trace, 'g2_update_failed'); reportTiming(trace); }
    notice.textContent = t('G2表示を更新できませんでした。接続を確認してください。');
  });
}

function clearClip(): void {
  clip?.fill(0); clip = undefined; discardButton.disabled = true;
}

const recorder = new Recorder(
  open => bridge?.audioControl(open, AudioInputSource.Glasses) ?? Promise.resolve(false),
  (wav) => {
    if (exited) return;
    audioTraceId ??= crypto.randomUUID();
    timing.mark(audioTraceId, 'audio_ready');
    clearClip(); clip = wav; discardButton.disabled = false;
    notice.textContent = '';
    progress.begin(audioTraceId, 'recognizing');
    busy = true; display(t('認識中'), getLanguage() === 'ja' ? `${hostName}で処理しています…` : `Processing on ${hostName}…`);
    const trace = audioTraceId;
    timing.mark(trace, 'asr_sent');
    void api<{text:string}>('/api/transcribe', 'POST', wav, trace).then(result => {
      if (exited) return;
      timing.mark(trace, 'asr_received');
      transcript.value = result.text; sendButton.disabled = false;
      progress.review(); notice.textContent = '';
      display(t('認識完了'), result.text);
      busy = false; clearClip();
      if (el<HTMLInputElement>('auto-send').checked) sendButton.click();
      else flushPendingDisplay();
      refreshStatus();
    }).catch(error => { busy = false; clearClip(); progress.setPhase('error'); notice.textContent = error.message; display(t('音声を認識できませんでした'), t('もう一度話してください')); flushPendingDisplay(); });
  },
  state => {
    if (state === 'stopping') { audioTraceId ??= crypto.randomUUID(); timing.mark(audioTraceId, 'recording_stop'); progress.begin(audioTraceId, 'recognizing'); refreshStatus(); }
    recordButton.textContent = state === 'idle' ? t('録音を開始') : t('録音を停止');
    recordButton.disabled = !glassesReady || state === 'stopping';
    if (state === 'idle' && pendingHistoryDisplay) flushPendingDisplay();
    else if (state === 'idle' && !clip && !busy) { progress.setPhase('idle'); display(t('G2接続済み'), t('音声を取得できませんでした。もう一度長押ししてください。')); }
    if (state === 'stop-error') recordButton.textContent = t('マイク停止を再試行');
    if (state === 'starting') { progress.setPhase('microphone'); audioTraceId = undefined; clearClip(); display(t('マイク準備中'), t('指を離すと停止します')); }
    if (state === 'recording') { progress.setPhase('recording'); display(t('録音中'), `${t('指を離すと停止します')}\n${t('最長30秒')}`); }
  },
  message => { progress.setPhase('error'); notice.textContent = message; display(t('確認が必要'), message); },
);

function startRecording(): void {
  if (exited) return;
  if (!glassesReady) { notice.textContent = t('G2との接続と起動状態を確認し、Dot Linkを開き直してください。'); return; }
  if (busy) { notice.textContent = t('処理が終わるまでお待ちください。'); return; }
  if (!token || !subscribed || progress.connection !== 'online') { notice.textContent = getLanguage() === 'ja' ? `${hostName}とDotへの接続を確認してください。` : `Check the connection to ${hostName} and Dot.`; return; }
  standby?.activity();
  window.speechSynthesis?.cancel(); void recorder.start();
}
recordButton.onclick = () => recorder.state === 'idle' ? startRecording() : void recorder.stop();
discardButton.onclick = () => {
  clearClip(); notice.textContent = t('録音を破棄しました。');
  progress.setPhase('idle');
  display(t('G2接続済み'), t('長押しで話してください')); flushPendingDisplay();
};
// A hidden phone page is not an explicit glasses-app exit. Keep the receiver
// and app-level standby alive; physical display power remains OS-owned.
window.addEventListener('pagehide', () => { pageActive = false; refreshStatus(false); });
function stopSession(): void {
  if (exited) return;
  exited = true; pageActive = false; connectionVersion++; connectionController.abort();
  updates.stop(); if (statusTimer) clearInterval(statusTimer); statusTimer = undefined;
  standby?.stop(); void syncHeadRaise();
  window.speechSynthesis?.cancel(); clearClip(); void recorder.stop(true);
}

async function connect(): Promise<void> {
  const appBridge = await waitForEvenAppBridge();
  void restoreRelay(appBridge);
  bridge = appBridge;
  startupStage = 'page';
  el('g2-diagnostic').textContent = 'G2_STARTUP_PENDING';
  const result = await appBridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: [
      new TextContainerProperty({ containerID: 1, containerName: 'status', xPosition: 8, yPosition: 8,
        width: 560, height: 36, content: 'Dot Link' }),
      new TextContainerProperty({ containerID: 2, containerName: 'conversation', xPosition: 8, yPosition: 50,
        width: 560, height: 180, isEventCapture: 1, content: t('長押しで話してください') }),
      new TextContainerProperty({ containerID: 3, containerName: 'help', xPosition: 8, yPosition: 244,
        width: 560, height: 36, content: t('長押しで録音 · 指を離すと停止') }),
    ],
  }));
  startupResult = result;
  if (result !== 0) throw new Error('Glasses page initialization failed');
  startupStage = 'ready'; glassesReady = true;
  standby?.start();
  void syncHeadRaise();
  void displayPreferences.attach(appBridge).then(restored => {
    if (exited) return;
    if (restored) applyDisplayPreferences();
    else void syncHeadRaise();
  });
  el('g2-diagnostic').textContent = 'G2_READY';
  lastSentStatus = '';
  connection.textContent = t('Even Hub接続済み');
  notice.textContent = '';
  recordButton.disabled = false;
  // History may finish loading before the Even bridge is ready. Repaint it
  // now: later polls with unchanged history otherwise never update the G2.
  if (messages.length > 0) {
    historyIndex = messages.length - 1;
    showMessage();
  } else {
    display(token ? t('G2接続済み') : t('接続設定が必要'), token ? t('長押しで話してください') : t('スマートフォンで接続設定を開いてください'));
  }
  appBridge.onEvenHubEvent(event => {
    if (exited) return;
    if (event.audioEvent && event.audioEvent.source !== AudioInputSource.Phone) recorder.append(event.audioEvent.audioPcm);
    const eventType = event.sysEvent?.eventType ?? event.textEvent?.eventType ?? event.listEvent?.eventType;
    if (eventType === OsEventTypeList.SYSTEM_EXIT_EVENT || eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT) { stopSession(); return; }
    if (eventType === OsEventTypeList.IMU_DATA_REPORT || event.sysEvent?.imuData) {
      if (event.sysEvent?.imuData && headRaise.sample(event.sysEvent.imuData, performance.now()) && standby?.hidden) standby.activity();
      updateHeadRaiseStatus();
      return;
    }
    // Foreground events describe the system menu overlay, not screen power.
    if (eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT || eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) return;
    const hasInput = !!(event.sysEvent || event.textEvent || event.listEvent);
    const isSingle = hasInput && (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined);
    const isGesture = isSingle || [OsEventTypeList.DOUBLE_CLICK_EVENT, OsEventTypeList.SCROLL_TOP_EVENT,
      OsEventTypeList.SCROLL_BOTTOM_EVENT, OsEventTypeList.LONG_PRESS_EVENT, OsEventTypeList.LONG_PRESS_RELEASE_EVENT].includes(eventType!);
    if (!isGesture) return;
    if (isSingle || eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      if (standby?.tap(isSingle ? 'single' : 'double')) return;
    } else if (standby?.hidden) return;
    if (hasInput) standby?.activity();
    if (eventType === OsEventTypeList.LONG_PRESS_EVENT) startRecording();
    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) el('previous').click();
    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) el('next').click();
    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void appBridge.shutDownPageContainer(1).then(ok => { if (!ok) notice.textContent = t('終了確認を開けませんでした'); }).catch(() => { notice.textContent = t('終了確認を開けませんでした'); });
    }
    if (eventType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) void recorder.stop();
  });
}

let imuActive = false;
let imuChain = Promise.resolve();
let imuWatchdog: ReturnType<typeof setTimeout> | undefined;
let headStatusAt = -Infinity;
let displaySaveVersion = 0;
function updateHeadRaiseStatus(): void {
  if (!displayPreferences.value.headRaise || exited) return;
  const now = performance.now();
  if (now - headStatusAt < 250 || headRaise.calibration(now) === undefined) return;
  headStatusAt = now;
  if (imuWatchdog) clearTimeout(imuWatchdog);
  const angle = Math.round(headRaise.angle ?? 0);
  el('head-raise-status').textContent = getLanguage() === 'ja' ? `現在の角度: ${angle}°` : `Current angle: ${angle}°`;
}
function syncHeadRaise(): Promise<void> {
  imuChain = imuChain.then(async () => {
    const enabled = displayPreferences.value.headRaise && glassesReady && !exited;
    if (!bridge || enabled === imuActive) return;
    if (imuWatchdog) clearTimeout(imuWatchdog);
    headRaise.reset(); headStatusAt = -Infinity;
    if (enabled) el('head-raise-status').textContent = t('頭の動きを確認しています…');
    try {
      const ok = await bridge.imuControl(enabled, ImuReportPace.P200);
      if (!ok) throw new Error('IMU control failed');
      imuActive = enabled;
      if (enabled && !exited && displayPreferences.value.headRaise) {
        imuWatchdog = setTimeout(() => {
          if (headRaise.calibration(performance.now()) === undefined) el('head-raise-status').textContent = t('頭の動きを取得できません。タップで再表示できます。');
        }, 4000);
      }
    } catch {
      el('head-raise-status').textContent = t('頭の動きを取得できません。タップで再表示できます。');
    }
  });
  return imuChain;
}
function applyDisplayPreferences(): void {
  const p = displayPreferences.value;
  el<HTMLInputElement>('display-idle').value = String(p.idleSeconds);
  el<HTMLSelectElement>('display-wake-tap').value = p.wakeTap;
  el<HTMLInputElement>('display-head-raise').checked = p.headRaise;
  el<HTMLInputElement>('display-head-angle').value = String(p.headAngle);
  el<HTMLInputElement>('display-head-angle').disabled = !p.headRaise;
  el<HTMLButtonElement>('display-calibrate').disabled = !p.headRaise;
  headRaise.configure(p); standby?.configure(p);
  el('head-raise-status').textContent = p.headRaise ? t('頭の動きを確認しています…') : t('顔上げでの再表示はオフです');
  void syncHeadRaise();
}
async function saveDisplayPreferences(p: DisplayPreferences, calibrated = false): Promise<void> {
  const version = ++displaySaveVersion;
  const saved = displayPreferences.save(p);
  applyDisplayPreferences();
  const retained = await saved;
  if (version !== displaySaveVersion || exited) return;
  el('display-settings-status').textContent = retained ? (calibrated ? t('正面の角度を保存しました') : t('表示設定を保存しました')) : t('この画面では設定を保存できません。閉じると設定が戻る場合があります。');
}
function initializeDisplaySettings(): void {
  applyDisplayPreferences();
  el<HTMLFormElement>('display-settings-form').onsubmit = event => {
    event.preventDefault();
    const idleSeconds = Number(el<HTMLInputElement>('display-idle').value);
    const headAngle = Number(el<HTMLInputElement>('display-head-angle').value);
    if (!Number.isInteger(idleSeconds) || (idleSeconds !== 0 && (idleSeconds < 5 || idleSeconds > 3600))) {
      el('display-settings-status').textContent = t('表示時間は0、または5〜3600秒で指定してください。'); return;
    }
    if (!Number.isInteger(headAngle) || headAngle < 5 || headAngle > 60) {
      el('display-settings-status').textContent = t('顔上げの角度は5〜60°で指定してください。'); return;
    }
    const wakeTap = el<HTMLSelectElement>('display-wake-tap').value === 'single' ? 'single' : 'double';
    void saveDisplayPreferences({ ...displayPreferences.value, idleSeconds, wakeTap, headAngle, headRaise: el<HTMLInputElement>('display-head-raise').checked });
  };
  el<HTMLInputElement>('display-head-raise').onchange = () => {
    el<HTMLInputElement>('display-head-angle').disabled = !el<HTMLInputElement>('display-head-raise').checked;
  };
  el('display-calibrate').onclick = () => {
    const neutralPitch = headRaise.calibration(performance.now());
    if (!displayPreferences.value.headRaise || neutralPitch === undefined) {
      el('display-settings-status').textContent = t('G2の接続と顔上げ設定を確認してから、もう一度お試しください。'); return;
    }
    void saveDisplayPreferences({ ...displayPreferences.value, neutralPitch }, true);
  };
  transcript.addEventListener('input', () => standby?.activity());
}

standby = new DisplayStandby(displayPreferences.value, hidden => {
  document.body.dataset.displayHidden = String(hidden);
  el('standby-status').textContent = hidden ? t('表示を消して待ち受け中') : t('表示中');
  queueDisplayFrame();
});
initializeDisplaySettings();
showSetup(!token);
if (token && !relay?.resumeToken) updates.start(true);
refreshStatus(false);
window.addEventListener('pageshow', event => { if (exited) return; pageActive = true; standby?.check(); refreshStatus(); if (event.persisted && token) updates.start(); });
window.addEventListener('online', () => { if (token && !exited) updates.start(); });
window.addEventListener('offline', () => { progress.connection = 'offline'; refreshStatus(); el('dot-status').textContent = `${hostName} · ${t('切断')}`; });
document.addEventListener('visibilitychange', () => { if (exited) return; standby?.check(); refreshStatus(); if (!document.hidden && token) updates.start(); });

void connect().catch(() => {
  const nativeReady = startupStage !== 'bridge';
  connection.textContent = nativeReady ? t('G2の画面を起動できませんでした') : t('Evenアプリとの接続準備ができませんでした');
  notice.textContent = nativeReady ? t('G2との接続と起動状態を確認し、Dot Linkを開き直してください。') : t('Evenアプリとの接続準備ができていません。アプリを閉じて開き直してください。');
  el('g2-diagnostic').textContent = nativeReady ? `G2_STARTUP_${startupResult ?? 'REQUEST_FAILED'}` : 'EVEN_BRIDGE_UNAVAILABLE';
});
