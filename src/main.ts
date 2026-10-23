import { RuntimeNative } from './runtime-native.ts';
import { AudioInputSource, CreateStartUpPageContainer, ImuReportPace, OsEventTypeList, TextContainerProperty,
  TextContainerUpgrade, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { readSTTProvider, speechDevice, speechStatus, type STTProvider } from './speech-status.ts';
import { sttErrorMessage } from './stt-errors.ts';
import { VoiceInput, type WakeState } from './voice-input.ts';
import { loadWakeDetector } from './wake-detector.ts';
import { OperationPreferences } from './operation-preferences.ts';
import { WakeNamePreferences } from './wake-name-preferences.ts';
import { validateWakeName } from './wake-name.ts';
import { wakeTranscript } from './wake-transcript.ts';
import { TimingTracker } from './timing.ts';
import { ConversationState, type ConversationMessage as Message } from './conversation-state.ts';
import { conversationText, receiptCaption, newReplyCaption } from './conversation-display.ts';
import { wrapHudText } from './hud-text.ts';
import { LiveUpdates } from './live-updates.ts';
import { Pairing } from './pairing.ts';
import { InteractionStatus } from './interaction-status.ts';
import { DisplayStandby, HeadRaiseDetector, type DisplayPreferences } from './display-standby.ts';
import { DisplayPreferenceStore } from './display-preferences.ts';
import { t, getLanguage, setLanguage, chooseLanguage, translateLabel } from './i18n.ts';
import { RelaySettings, PendingUtterance } from './relay-connection.ts';
import { parseInvite, type PairingInvite } from './relay-origin.ts';
import { LanguagePreferences } from './language-preferences.ts';
import { LocationSharing, type LocationRelayStatus } from './location-sharing.ts';
import { installKeyboardViewport } from './keyboard-viewport.ts';
import { SpeechPlayback } from './speech-playback.ts';
import { ReadAloudPreferences } from './read-aloud-preferences.ts';
import { G2Display } from './g2-display.ts';
import { RelaySession } from './relay-session.ts';
import { RuntimeEffects } from './runtime-effects.ts';
import { ConnectionTransitions } from './connection-transitions.ts';
import { ExitDiagnostics } from './exit-diagnostics.ts';
import './style.css';

installKeyboardViewport(document.querySelector<HTMLElement>('main')!);

const languagePreferences = new LanguagePreferences(() => localStorage);
const staticLabels = [...document.querySelectorAll<HTMLElement>('[data-en]')].map(element => ({
  element, ja: element.textContent ?? '', en: element.dataset.en!,
}));
setLanguage(chooseLanguage(navigator.language, languagePreferences.value));
document.documentElement.lang = getLanguage();
for (const { element, ja, en } of staticLabels) element.textContent = getLanguage() === 'ja' ? ja : en;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const displayPreferences = new DisplayPreferenceStore(() => localStorage);
const operationPreferences = new OperationPreferences(() => localStorage);
const readAloudPreferences = new ReadAloudPreferences(() => localStorage);
const wakeNamePreferences = new WakeNamePreferences(() => localStorage);
let wakeState: WakeState = 'off';
const headRaise = new HeadRaiseDetector(displayPreferences.value);
let standby: DisplayStandby | undefined;
el('app-version').textContent = `v${import.meta.env.VITE_APP_VERSION}`;
const connection = el('connection');
const notice = el('notice');
const pairingNotice = el('pair-notice');
const recordButton = el<HTMLButtonElement>('record');
const discardButton = el<HTMLButtonElement>('discard');
const sendButton = el<HTMLButtonElement>('send');
const transcript = el<HTMLTextAreaElement>('transcript');
const pairingInput = el<HTMLTextAreaElement>('pair-code');
const relaySettings = new RelaySettings(() => localStorage);
const pairing = new Pairing(() => localStorage, () => sessionStorage);
const runtimeNative = new RuntimeNative();
const session = new RelaySession({
  settings: relaySettings, legacyToken: pairing.read(), appOrigin: location.origin,
  fetch: (input, init) => fetch(input, init),
  rejected: reason => forgetPairing(reason === 'expired'
    ? t('接続の有効期限が切れたか、Mac側で解除されました。新しい接続コードで接続してください。')
    : t('接続設定が無効になりました。Macで新しい接続コードを発行してください。')),
  superseded: () => retireSupersededRuntime(),
  persistenceFailed: () => { notice.textContent = t('Even側への接続情報の保存を確認できません。次回の更新時に再接続が必要な場合があります。'); },
});
const setupPanel = el<HTMLDetailsElement>('mac-setup');
let copyToastTimer: ReturnType<typeof setTimeout> | undefined;
function showCopyToast(message: string): void {
  clearTimeout(copyToastTimer);
  el('copy-toast').textContent = message;
  copyToastTimer = setTimeout(() => { el('copy-toast').textContent = ''; }, 2500);
}
el('copy-mac-url').onclick = async () => {
  const url = el('mac-download-url').textContent?.trim() ?? '';
  const status = el('mac-copy-status');
  status.textContent = '';
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = t('URLをコピーしました。Macのブラウザーで開いてください。');
    showCopyToast(t('コピーしました'));
  } catch {
    status.textContent = t('コピーできませんでした。表示されているURLをMacのブラウザーに入力してください。');
    showCopyToast(t('コピーできませんでした'));
  }
};
// Hide the fixed display-settings action bar while working in setup.
setupPanel.addEventListener('toggle', () => {
  if (setupPanel.open) el<HTMLDetailsElement>('display-settings').open = false;
  else if (session.token) pairingNotice.textContent = '';
});
function showSetup(unpaired: boolean): void {
  document.body.dataset.pairState = unpaired ? 'unpaired' : 'paired';
  setupPanel.open = unpaired;
  el('forget-pairing').hidden = unpaired;
  el('pair').hidden = !offeredInvite;
  if (unpaired) el<HTMLDetailsElement>('display-settings').open = false;
}
let pendingDelivery = new PendingUtterance(() => localStorage, session.credentials?.origin ?? location.origin);
let exited = false;
let relayRestored = !session.credentials?.resumeToken;
let glassesReady = false;
let startupStage: 'bridge' | 'page' | 'ready' = 'bridge';
let startupResult: number | undefined;
let offeredInvite: PairingInvite | undefined;
const pairingToken = new URLSearchParams(location.hash.slice(1)).get('pair');
if (!session.credentials && pairingToken && /^[A-Za-z0-9_-]{43}$/.test(pairingToken)) {
  session.use(undefined, pairingToken); pairing.save(session.token);
  history.replaceState(null, '', location.pathname + location.search);
}
el('app-origin').textContent = location.origin;
el('show-diagnostics').onclick = () => {
  const details = el('connection-diagnostics'); details.hidden = !details.hidden;
  el('show-diagnostics').setAttribute('aria-expanded', String(!details.hidden));
};
const exitDiagnostics = new ExitDiagnostics({
  enabled: import.meta.env.VITE_EXIT_DIAGNOSTICS === '1', storage: () => localStorage,
  changed: text => { const panel = el('exit-diagnostic'); panel.hidden = false; panel.textContent = text; },
  log: text => console.info(text),
});
exitDiagnostics.record('boot');
const language = el<HTMLSelectElement>('language'); language.value = languagePreferences.value;
renderPhoneLabels();
renderRecordControl('idle');
language.onchange = () => {
  if (busy || recorder.state !== 'idle') { language.value = languagePreferences.value; notice.textContent = t('処理が終わるまでお待ちください。'); return; }
  if (!['auto', 'ja', 'en'].includes(language.value)) return;
  void languagePreferences.save(language.value as 'auto' | 'ja' | 'en').then(saved => {
    if (!saved && !exited) notice.textContent = t('この画面では設定を保存できません。閉じると設定が戻る場合があります。');
  });
  applyLanguage();
};
const progress = new InteractionStatus();
progress.connection = session.token ? 'connecting' : 'unpaired';
let hostName = t('接続先');
let namedHost = false;
let baseStatus = t('長押しで話してください');
let renderBaseStatus: () => string = () => t('長押しで話してください');
let statusTimer: ReturnType<typeof setInterval> | undefined;
let selectedSTT: STTProvider | undefined;
let selectedSTTModel: unknown;
const ttsDevice = speechDevice(navigator.userAgent, navigator.maxTouchPoints);
const speechCaption = () => speechStatus(selectedSTT, progress.connection === 'online', tts, 'speechSynthesis' in window, ttsDevice, selectedSTTModel);
// Keep the divider in the text frame so standby clears and restores it with the status.
const speechDisplayCaption = () => `${'─'.repeat(24)}\n${speechCaption()}`;
let pageActive = true;
const locationSharing = new LocationSharing({
  storage: () => localStorage,
  target: () => session.token ? session.credentials?.origin ?? location.origin : undefined,
  api: async (path, body) => {
    const input = body as {enabled?: boolean; fix?: unknown};
    exitDiagnostics.record(path === '/api/location/control' ? (input.enabled ? 'share-enable' : 'share-disable') : (input.fix ? 'share-fix' : 'share-heartbeat'));
    try { const result = await session.location(path, body); exitDiagnostics.record('share-ok'); return result; }
    catch (error) { exitDiagnostics.record('share-failed'); throw error; }
  },
  changed: () => renderLocationStatus(),
});
function renderLocationStatus(): void {
  if (exited) return;
  const s = locationSharing.status(), ja = getLanguage() === 'ja';
  el<HTMLInputElement>('location-share').checked = s.enabled;
  const labels = {
    off: ['共有していません', 'Not sharing'], starting: ['位置情報を準備しています…', 'Starting location sharing…'],
    waiting: ['現在地を取得しています…', 'Waiting for a current location…'], sharing: ['現在地を共有中', 'Sharing your current location'],
    stale: ['現在地の更新を待っています', 'Waiting for a fresh location'],
    unavailable: ['位置情報を取得できません。Evenアプリの位置情報の許可を確認し、共有をオフ・オンしてください。', 'Location is unavailable. Check location permission for the Even app, then turn sharing off and on.'],
    offline: ['Macへの位置共有を再接続しています…', 'Reconnecting location sharing to your Mac…'],
    stopping: ['この端末の共有は停止しました。Mac側の停止確認を待っています。', 'Sharing has stopped on this device. Waiting to confirm the stop on your Mac.'],
  };
  el('location-status').textContent = labels[s.state][ja ? 0 : 1] + (!s.saved ? (ja ? ' 設定の保存を確認できません。' : ' Settings could not be saved.') : '');
  el('location-dot-status').textContent = !s.enabled ? '' : s.dotSubscribed ?
    (ja ? 'Dotが位置の変化を受け取れる状態です。知らせる内容とタイミングはDotが判断します。' : 'Dot is ready to receive location changes and decide whether and when to reach out.') :
    (ja ? 'Dot側の位置共有の接続を待っています。' : 'Waiting for Dot to connect to location sharing.');
  el('location-diagnostic').textContent = `${ja ? '位置共有' : 'Location'}: ${s.state} · ${ja ? '受信' : 'received'} ${s.receivedCount ?? 0} · ${ja ? '案内' : 'announcements'} ${s.announcementCount ?? 0}${s.accuracy === undefined ? '' : ` · ±${Math.round(s.accuracy)}m`}${s.receivedAt ? ` · ${new Date(s.receivedAt).toLocaleTimeString()}` : ''}`;
}
el<HTMLInputElement>('location-share').onchange = () => locationSharing.setEnabled(el<HTMLInputElement>('location-share').checked);
const connectionTransitions = new ConnectionTransitions({
  session,
  stopUpdates: () => updates.stop(), cancelPlayback: () => playback.cancel(),
  stopLocation: () => locationSharing.setEnabled(false), clearLegacyPairing: () => pairing.forget(),
  resetInteraction: (pairing, newIdentity) => {
    transcriptionController?.abort(); transcriptionController = undefined;
    busy = pairing; clearClip(); audioTraceId = undefined; discarding = false;
    el<HTMLButtonElement>('pair').disabled = pairing; sendButton.disabled = pairing || !transcript.value.trim();
    if (newIdentity) { progress.reset(); timing.reset(); } else progress.setPhase('idle');
  },
  resetConversation: () => conversation.reset(),
  resetDelivery: (origin, clearRetry) => {
    pendingDelivery = new PendingUtterance(() => localStorage, origin ?? location.origin);
    if (clearRetry) { pendingId = undefined; pendingText = undefined; }
  },
  resetConnectionInfo: () => {
    subscribed = false; progress.dotConnected = false;
    hostName = t('接続先'); namedHost = false; selectedSTT = readSTTProvider(undefined); selectedSTTModel = undefined;
  },
});
function forgetPairing(message: string): void {
  connectionTransitions.forget();
  pairingInput.value = ''; offeredInvite = undefined;
  showSetup(true);
  progress.connection = 'unpaired'; syncRuntimeEffects();
  display(() => t('再接続が必要です'), message);
  el('dot-status').textContent = t('再接続が必要です');
  notice.textContent = ''; pairingNotice.textContent = message;
  setupPanel.open = true;
}
let busy = false;
let subscribed = false;
// Packaged origins can retain stale local ON values; wait for native restore.
let tts = false;
renderReadAloudControl();
const conversation = new ConversationState();
const timing = new TimingTracker();
let audioTraceId: string | undefined;

async function restoreRelay(appBridge: EvenAppBridge): Promise<void> {
  const version = session.version;
  const saved = await relaySettings.attach(runtimeNative.storage(appBridge));
  if (version !== session.version || exited) return;
  relayRestored = true;
  // Legacy development credentials are separate from packaged pairing.
  if (!saved && !session.credentials) return;
  connectionTransitions.restore(saved);
  if (!saved) { showSetup(true); progress.connection = 'unpaired'; syncRuntimeEffects(); display(() => t('再接続が必要です'), () => t('接続先を確認して「接続」を押してください。')); return; }
  showSetup(false); progress.connection = 'connecting'; syncRuntimeEffects(); display(() => t('再接続中'), idleVoicePrompt);
  updates.start(true);
}

async function api<T>(path: string, method = 'GET', body?: string | Uint8Array, trace?: string, requestSignal?: AbortSignal): Promise<T> {
  if (!relayRestored) throw new Error(t('接続を確認中'));
  const version = session.version;
  const current = () => { if (exited || !session.isCurrent(version)) throw new Error('Connection changed'); };
  const response = await session.request(path, method, body, trace, requestSignal);
  current();
  if (!response.ok && path === '/api/transcribe' && response.status === 422) {
    const failure = await response.json().catch(() => ({})); current();
    throw new Error(sttErrorMessage(failure.code) ?? t('処理できませんでした。接続または録音を確認してください。'));
  }
  if (!response.ok) throw new Error(response.status === 401 && !session.credentials?.resumeToken ? t('Macで新しい接続コードを発行し、貼り付けてください。') : t('処理できませんでした。接続または録音を確認してください。'));
  const result = response.status === 204 ? undefined : await response.json();
  current();
  return result as T;
}

function reportTiming(id: string): void {
  const report = timing.report(id);
  if (report) void api('/api/timings', 'POST', JSON.stringify(report)).catch(() => {});
}

function showMessage(): void {
  const message = conversation.selectedForDisplay();
  if (!message) return;
  const current = () => conversation.find(message.id) ?? message;
  display(() => {
    const item = current();
    return item.reply ? `${conversation.position(item.id)}/${conversation.count}` :
      item.status === 'failed' ? t('送信未確認') : t('{name}の返信待ち').replace('{name}', wakeNamePreferences.assistantName);
  }, () => conversationText(current(), Date.now(), wakeNamePreferences.assistantName), message.id);
}
function currentReceipt(): string { return receiptCaption(conversation.visible); }
function currentNewReplies(): string { return newReplyCaption(conversation.unreadCount); }

interface Snapshot { revision: string; status: { subscribed: boolean; deviceName?: string; sttProvider?: unknown; sttModel?: unknown } & LocationRelayStatus; messages: Message[]; }
function receiveUpdate(snapshot: Snapshot, initial = false): void {
  if (exited) return;
  locationSharing.receive(snapshot.status);
  subscribed = snapshot.status.subscribed;
  selectedSTT = readSTTProvider(snapshot.status.sttProvider);
  selectedSTTModel = snapshot.status.sttModel;
  progress.connection = 'online'; progress.dotConnected = subscribed; attachLocation();
  if (snapshot.status.deviceName) { hostName = snapshot.status.deviceName; namedHost = true; }
  const update = conversation.receive(snapshot.messages, initial, message => locationSharing.acceptsAnnouncement(message));
  for (const message of update.announcements) {
    progress.complete(message.id);
    timing.mark(message.id, 'reply_received');
    if (tts && 'speechSynthesis' in window) {
      const speech = new SpeechSynthesisUtterance(message.reply); speech.lang = getLanguage() === 'ja' ? 'ja-JP' : 'en-US';
      playback.speak(speech);
    }
  }
  if (update.waiting) progress.restoreWaiting(update.waiting.id, update.waiting.createdAt, Date.now());
  el('dot-status').textContent = `${hostName} · ${subscribed ? t('Dot接続済み') : t('Dot未接続')}`;
  flushPendingDisplay();
  updateRuntime();
}
function flushPendingDisplay(): void {
  const effect = conversation.flush({
    allowed: !busy && recorder.state === 'idle' && !['review', 'error'].includes(progress.phase),
    hidden: standby?.hidden ?? false,
    mayAnnounce: message => locationSharing.acceptsAnnouncement(message),
  });
  if (effect.display) showMessage();
  if (effect.wake) standby?.activity();
  updateRuntime();
}

const updates = new LiveUpdates<Snapshot>((revision, signal) => session.updates<Snapshot>(revision, signal), receiveUpdate, () => {
  progress.connection = 'offline'; updateRuntime();
  el('dot-status').textContent = `${hostName} · ${t('再接続中')}`;
});

function offerInvite(raw: string): void {
  offeredInvite = parseInvite(raw);
  el('pair-destination').textContent = offeredInvite.origin;
  el('pair').hidden = false;
  pairingNotice.textContent = t('接続先を確認して「接続」を押してください。');
}
pairingInput.oninput = () => {
  offeredInvite = undefined; el('pair-destination').textContent = ''; el('pair').hidden = true;
  try { offerInvite(pairingInput.value); } catch { pairingNotice.textContent = t('接続コードが無効か期限切れです。Macで新しく発行してください。'); }
};
el('pair').onclick = async () => {
  if (busy || recorder.state !== 'idle' || exited) return;
  let invite: PairingInvite;
  try { invite = parseInvite(offeredInvite ? JSON.stringify(offeredInvite) : pairingInput.value); }
  catch { pairingNotice.textContent = getLanguage() === 'ja' ? 'Macで接続コードをコピーして、全体を貼り付けてください。' : 'Copy the pairing code on your Mac and paste the entire code here.'; return; }
  busy = true; const button = el<HTMLButtonElement>('pair'); button.disabled = true;
  connectionTransitions.beginPairing();
  const version = session.version;
  progress.connection = 'connecting'; updateRuntime();
  try {
    const credentials = await session.pair(invite);
    if (version !== session.version || exited) return;
    const retained = connectionTransitions.paired(credentials); relayRestored = true;
    const snapshot = await api<Snapshot>('/api/updates'); receiveUpdate(snapshot, true); updates.start(false, snapshot.revision);
    pairingInput.value = ''; offeredInvite = undefined;
    const nativeRetained = await relaySettings.nativeSaved();
    if (version !== session.version || exited) return;
    pairingNotice.textContent = '';
    notice.textContent = nativeRetained && credentials.resumeToken ? t('接続しました。更新後の再接続情報も保存しました。') : retained ? t('接続しました。更新後の自動復元は未確認です。') : t('接続しました。この画面では設定を保存できないため、閉じた後は新しい接続コードで接続してください。');
    el('diagnostic').textContent = getLanguage() === 'ja' ? '接続確認成功' : 'Connection verified';
    showSetup(false);
  } catch (error) {
    if (version !== session.version || exited) return;
    progress.connection = session.token ? 'offline' : 'unpaired'; updateRuntime();
    setupPanel.open = true;
    pairingNotice.textContent = t('Macが停止・スリープ・オフラインの場合は接続できません。');
    el('diagnostic').textContent = getLanguage() === 'ja' ? 'Tailscale接続、Macの状態、コードの期限を確認してください。' : 'Check Tailscale, your Mac, and code expiry.';
    if (session.token && relayRestored) updates.start(true);
  } finally { if (!exited && session.isCurrent(version)) { busy = false; button.disabled = false; sendButton.disabled = !transcript.value.trim(); flushPendingDisplay(); } }
};
el('forget-pairing').onclick = async () => {
  if (busy || recorder.state !== 'idle') return;
  busy = true; let revoked = false; const version = session.version;
  try { if (session.credentials) { await api('/api/pair/revoke', 'POST'); revoked = true; } }
  catch {} finally {
    if (exited || !session.isCurrent(version)) return;
    forgetPairing(revoked ? t('接続を解除しました。') : t('この端末の接続設定を削除しました。Mac側の解除は未確認です。Macの「Evenの接続設定」→「Evenの接続をすべて解除」で解除してください。ほかのEven接続も解除されます。'));
    busy = false; display(() => t('接続設定が必要'), () => t('スマートフォンで接続設定を開いてください'));
  }
};
el('tts').onclick = () => {
  tts = !tts; renderReadAloudControl();
  void readAloudPreferences.save(tts).then(saved => {
    if (!saved && !exited) notice.textContent = t('この画面では設定を保存できません。閉じると設定が戻る場合があります。');
  });
  if (tts && 'speechSynthesis' in window) { const speech = new SpeechSynthesisUtterance(t('読み上げをオンにしました')); speech.lang = getLanguage() === 'ja' ? 'ja-JP' : 'en-US'; playback.speak(speech); }
  else playback.cancel();
  updateRuntime();
};
el('previous').onclick = () => { standby?.activity(); conversation.navigate(-1); showMessage(); };
el('next').onclick = () => { standby?.activity(); conversation.navigate(1); showMessage(); };
let pendingId: string | undefined;
let pendingText: string | undefined;
sendButton.onclick = async () => {
  const text = transcript.value.trim(); if (!text || busy || !session.token || exited) return;
  standby?.activity();
  busy = true; sendButton.disabled = true;
  updateRuntime(false);
  const version = session.version;
  try {
    if (pendingText !== text) {
      const preparedId = await pendingDelivery.prepare(text, audioTraceId);
      if (exited || !session.isCurrent(version)) return;
      pendingId = preparedId; pendingText = text; audioTraceId = undefined;
    }
    if (version !== session.version || exited) return;
    progress.begin(pendingId!, 'sending'); updateRuntime();
    timing.mark(pendingId!, 'utterance_sent');
    const message = await api<Message>('/api/utterances', 'POST', JSON.stringify({id:pendingId,text}));
    timing.mark(pendingId!, 'utterance_accepted');
    reportTiming(pendingId!);
    if (message.status === 'failed') throw new Error(t('配送を確認できませんでした。同じ発話は重複送信しません。'));
    progress.waiting(message.id, message.createdAt, Date.now());
    pendingDelivery.clear();
    transcript.value = ''; pendingId = undefined; pendingText = undefined;
    if (conversation.acceptSent(message).reply) progress.complete(message.id);
    showMessage();
    notice.textContent = '';
  } catch (error) {
    if (version !== session.version || exited) return;
    progress.setPhase('error'); notice.textContent = (error as Error).message;
    display(() => t('送信を確認できませんでした'), (error as Error).message);
  }
  finally { if (!exited && session.isCurrent(version)) { busy = false; sendButton.disabled = !transcript.value.trim(); flushPendingDisplay(); syncRuntimeEffects(); } }
};
transcript.oninput = () => { sendButton.disabled = busy || !transcript.value.trim(); syncRuntimeEffects(); };

let bridge: EvenAppBridge | undefined;
let clip: Uint8Array | undefined;
let discarding = false;
let holdRecording = false;
let operationPreferencesReady = false;
let transcriptionController: AbortController | undefined;
let lastDisplayText = t('長押しで話してください');
let renderDisplayText: () => string = () => t('長押しで話してください');

function syncRuntimeEffects(): void { runtimeEffects.sync(); }
function updateRuntime(sendToG2 = true): void {
  syncRuntimeEffects(); refreshStatus(sendToG2);
}
function hudCaption(): string {
  return recorder.source === 'wake' && recorder.state === 'recording' ? t('話してください') : progress.caption(baseStatus, conversation.visibleId, wakeNamePreferences.assistantName);
}
function keepWakeConversation(): boolean {
  return recorder.source === 'wake' && !!conversation.visible;
}
function idleVoicePrompt(): string {
  const wake = operationPreferences.wakeWord && wakeState === 'listening';
  if (operationPreferences.disableHoldRecording) return wake ? wakeText('{wake}で話せます') : t('スマートフォンでテキストを入力してください');
  return wake ? wakeText('{wake} または長押しで話してください') : t('長押しで話してください');
}
function wakeText(key: Parameters<typeof t>[0]): string { return t(key).replace('{wake}', `Hey ${wakeNamePreferences.wakeName}`); }
function renderWakeState(): void {
  const labels = { off: '', loading: wakeText('{wake}を準備中…'), listening: '',
    paused: wakeText('{wake}は一時停止中'), error: wakeText('{wake}を使えません。オフにしてから再度オンにしてください。') };
  el('wake-status').textContent = labels[wakeState];
}
const playback = new SpeechPlayback({
  synthesis: () => window.speechSynthesis,
  canSpeak: () => recorder.state === 'idle' && !busy,
  changed: () => syncRuntimeEffects(),
  failed: () => { notice.textContent = t('読み上げできませんでした。画面の返信をご確認ください。'); },
  now: () => performance.now(), schedule: (callback, ms) => setTimeout(callback, ms), cancelTimer: timer => clearTimeout(timer),
});
const g2Display = new G2Display({
  ready: () => !!bridge && glassesReady,
  hidden: () => standby?.hidden ?? false,
  frame: () => ({status: hudCaption(), conversation: wrapHudText(lastDisplayText),
    help: recordingHint(), speech: speechDisplayCaption(), receipt: currentReceipt(), newReplies: currentNewReplies()}),
  writer: () => {
    const activeBridge = bridge!;
    return (containerID, containerName, content) => activeBridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID, containerName, contentOffset: 0, contentLength: content.length, content,
    }));
  },
  failed: kind => {
    if (kind === 'status') connection.textContent = t('G2の表示更新を確認できません');
    else notice.textContent = t('G2表示を更新できませんでした。接続を確認してください。');
  },
  timing: (id, stage) => timing.mark(id, stage), report: reportTiming,
});

// These renderers only describe phone controls. Native actions, persistence and
// the shared HUD continue to use their existing owners and event handlers.
function phoneLabel(id: string, label: string): void {
  el(id).setAttribute('aria-label', label);
  el(id).title = label;
}
function renderPhoneLabels(): void {
  transcript.placeholder = t('Dotにメッセージ…');
  phoneLabel('transcript', t('Dotへのメッセージ'));
  phoneLabel('previous', t('前の会話'));
  phoneLabel('next', t('次の会話'));
  phoneLabel('discard', t('録音を破棄'));
  phoneLabel('send', t('Dotに送信'));
}
function renderRecordControl(state: VoiceInput['state']): void {
  recordButton.dataset.recordState = state;
  phoneLabel('record', state === 'idle' ? t('録音を開始') : state === 'stop-error' ? t('マイク停止を再試行') : t('録音を停止'));
}
function renderReadAloudControl(): void {
  el('tts').setAttribute('aria-pressed', String(tts));
  phoneLabel('tts', `${t('読み上げ')} ${tts ? 'ON' : 'OFF'}`);
}
function renderPhoneStatus(): void {
  const selected = conversation.selected;
  const position = `${selected ? conversation.position(selected.id) : 0} / ${conversation.count}`;
  const counter = el('conversation-position');
  if (counter.textContent !== position) counter.textContent = position;
  const state = recorder.state;
  const status = state === 'stop-error' ? t('マイク停止を再試行') : state === 'stopping' ? t('マイクを停止中…') :
    state === 'starting' ? t('マイク準備中') : state === 'recording' ? `${t('録音中')} · ${t('録音ボタンで停止します')}` :
    progress.phase === 'recognizing' ? t('認識中') : progress.phase === 'sending' ? t('送信中') : '';
  const caption = el('phone-control-status');
  caption.dataset.state = state;
  if (caption.textContent !== status) caption.textContent = status;
}

// A timer updates only the short status line. Keep at most one queued update
// and read its latest value when it runs, so slow BLE never queues old seconds.
function refreshStatus(sendToG2 = true): void {
  if (exited) return;
  renderPhoneStatus();
  baseStatus = renderBaseStatus();
  const nextText = renderDisplayText();
  if (nextText !== lastDisplayText) {
    lastDisplayText = nextText; el('hud-content').textContent = nextText;
    if (sendToG2) queueDisplayFrame();
  }
  const caption = hudCaption();
  const speech = speechCaption();
  el('speech-status').textContent = speech;
  el('hud-state').textContent = caption;
  el('hud-state').dataset.state = progress.state;
  const ticking = (progress.ticking || progress.protectWaiting) && !standby?.hidden;
  if (ticking && !statusTimer) statusTimer = setInterval(() => refreshStatus(), 1000);
  else if (!ticking && statusTimer) { clearInterval(statusTimer); statusTimer = undefined; }
  if (sendToG2) g2Display.refreshStatus();
}

function display(state: string | (() => string), text: string | (() => string), trace?: string): void {
  if (exited) return;
  renderBaseStatus = typeof state === 'function' ? state : () => state;
  renderDisplayText = typeof text === 'function' ? text : () => text;
  baseStatus = renderBaseStatus(); conversation.present(trace);
  if (trace && !timing.report(trace)) trace = undefined;
  refreshStatus(false);
  lastDisplayText = renderDisplayText();
  el('hud-content').textContent = lastDisplayText;
  queueDisplayFrame(trace);
}

function queueDisplayFrame(trace?: string): void { g2Display.render(trace); }

function applyLanguage(): void {
  language.value = languagePreferences.value;
  const next = chooseLanguage(navigator.language, languagePreferences.value);
  if (next === getLanguage()) return;
  setLanguage(next); document.documentElement.lang = next;
  renderLocationStatus();
  for (const { element, ja, en } of staticLabels) {
    // Runtime status/controls may have replaced the initial label.
    if (element.textContent === ja || element.textContent === en) element.textContent = next === 'ja' ? ja : en;
  }
  for (const id of ['connection', 'notice', 'pair-notice', 'display-settings-status', 'head-raise-status', 'mac-copy-status', 'copy-toast', 'wake-name-status', 'wake-name-save-status', 'hold-save-status']) {
    const element = el(id); element.textContent = translateLabel(element.textContent ?? '');
  }
  renderPhoneLabels(); renderRecordControl(recorder.state);
  renderWakeState(); renderOperationSettings();
  renderReadAloudControl();
  if (!namedHost) hostName = t('接続先');
  el('dot-status').textContent = `${hostName} · ${progress.connection === 'online' ? (subscribed ? t('Dot接続済み') : t('Dot未接続')) : progress.connection === 'unpaired' ? t('接続設定が必要') : t('再接続中')}`;
  baseStatus = renderBaseStatus(); lastDisplayText = renderDisplayText();
  el('hud-content').textContent = lastDisplayText;
  g2Display.invalidate();
  refreshStatus(false); queueDisplayFrame();
}
window.addEventListener('languagechange', () => { if (!exited && languagePreferences.value === 'auto') applyLanguage(); });

function clearClip(): void {
  clip?.fill(0); clip = undefined; discardButton.disabled = true;
}

const recorder = new VoiceInput({
  microphone: open => runtimeNative.control(() => bridge?.audioControl(open, AudioInputSource.Glasses) ?? Promise.resolve(false)),
  loadWake: loadWakeDetector,
  onWakeState: state => { if (exited) return; wakeState = state; renderWakeState(); },
  onClip: (wav, _seconds, source, capturedWakeName) => {
    if (exited || discarding || (source === 'manual' && operationPreferences.disableHoldRecording)) { wav.fill(0); return; }
    transcriptionController?.abort();
    const controller = new AbortController(); transcriptionController = controller;
    const version = session.version;
    audioTraceId ??= crypto.randomUUID();
    timing.mark(audioTraceId, 'audio_ready');
    clearClip(); clip = wav; discardButton.disabled = false;
    notice.textContent = '';
    progress.begin(audioTraceId, 'recognizing');
    busy = true; syncRuntimeEffects();
    if (keepWakeConversation()) updateRuntime();
    else display(() => t('認識中'), () => getLanguage() === 'ja' ? `${hostName}で処理しています…` : `Processing on ${hostName}…`);
    const trace = audioTraceId;
    timing.mark(trace, 'asr_sent');
    void api<{text:string}>('/api/transcribe', 'POST', wav, trace, controller.signal).then(result => {
      if (exited || version !== session.version || controller.signal.aborted) return;
      timing.mark(trace, 'asr_received');
      const text = source === 'wake' ? wakeTranscript(result.text, capturedWakeName) : result.text;
      if (!text.trim()) {
        busy = false; clearClip(); progress.setPhase('idle');
        if (keepWakeConversation()) updateRuntime();
        else display(() => t('G2接続済み'), idleVoicePrompt);
        flushPendingDisplay();
        return;
      }
      transcript.value = text; sendButton.disabled = false;
      progress.review(); notice.textContent = '';
      display(() => t('認識完了'), text);
      busy = false; clearClip();
      if (el<HTMLInputElement>('auto-send').checked) sendButton.click();
      else flushPendingDisplay();
      updateRuntime();
    }).catch(error => { if (exited || version !== session.version || controller.signal.aborted) return; busy = false; clearClip(); progress.setPhase('error'); notice.textContent = error.message; display(() => t('音声を認識できませんでした'), error.message); flushPendingDisplay(); })
      .finally(() => { if (transcriptionController === controller) transcriptionController = undefined; });
  },
  onState: state => {
    if (exited) return;
    try {
      if (state === 'idle') holdRecording = false;
      renderRecordControl(state);
      recordButton.disabled = !glassesReady || state === 'stopping' || (state === 'idle' && operationPreferences.disableHoldRecording);
      // Session loss stops capture too. Its completion must not overwrite the
      // reconnection explanation or re-enter recognition without a pairing.
      if (!session.token && (state === 'stopping' || state === 'idle')) {
        discarding = false;
        progress.setPhase('idle'); updateRuntime(); return;
      }
      if (state === 'stopping' && !discarding) { audioTraceId ??= crypto.randomUUID(); timing.mark(audioTraceId, 'recording_stop'); progress.begin(audioTraceId, 'recognizing'); updateRuntime(); }
      if (state === 'idle' && discarding) { showDiscarded(); return; }
      // A no-speech cancellation has no onClip callback to end recognition.
      // Leave the existing conversation container untouched so its native scroll
      // position survives cancellation; only the transient status needs resetting.
      if (state === 'idle' && !clip && !busy) {
        progress.setPhase('idle');
        if (keepWakeConversation()) updateRuntime();
        else display(() => t('G2接続済み'), () => recorder.source === 'wake' ? idleVoicePrompt() : (operationPreferences.disableHoldRecording ? idleVoicePrompt() : t('音声を取得できませんでした。もう一度長押ししてください。')));
      }
      if (state === 'idle' && conversation.hasPendingDisplay) flushPendingDisplay();
      if (state === 'starting') { progress.setPhase('microphone'); audioTraceId = undefined; clearClip(); display(() => t('マイク準備中'), () => holdRecording ? t('指を離すと停止します') : t('録音ボタンで停止します')); }
      if (state === 'recording') {
        standby?.activity();
        discardButton.disabled = false;
        progress.setPhase('recording');
        if (recorder.source === 'wake') {
          audioTraceId = undefined; clearClip(); discardButton.disabled = false;
          if (keepWakeConversation()) updateRuntime();
          else display(() => t('話してください'), () => el<HTMLInputElement>('auto-send').checked ? t('話し終わると送信します') : t('話し終わると認識します'));
        } else display(() => t('録音中'), () => `${holdRecording ? t('指を離すと停止します') : t('録音ボタンで停止します')}\n${t('最長30秒')}`);
      }
    } finally { syncRuntimeEffects(); renderPhoneStatus(); }
  },
  onError: message => { if (exited) return; progress.setPhase('error'); syncRuntimeEffects(); notice.textContent = message; display(() => t('確認が必要'), message); },
});

const runtimeEffects = new RuntimeEffects({
  state: () => ({exited, tts, ready: glassesReady, paired: !!session.token, subscribed,
    online: progress.connection === 'online', busy, recording: recorder.state !== 'idle',
    draft: !!transcript.value.trim(), playbackBlocks: playback.blocksInput,
    phaseProtect: ['recognizing', 'sending'].includes(progress.phase), waitingMs: progress.waitingProtectionMs}),
  flushSpeech: () => playback.flush(),
  voiceContext: (available, blocked, active) => recorder.setContext(available, blocked, active),
  protectStandby: blocked => standby?.protect(blocked),
  schedule: (callback, ms) => setTimeout(callback, ms), cancel: timer => clearTimeout(timer),
});

let wakeNameEdited = false;
let wakeNameSaveVersion = 0;
let wakeNamePersistenceVersion = 0;
function renderWakeNameControls(): void {
  el<HTMLInputElement>('custom-wake-name').checked = wakeNamePreferences.value.custom;
  el<HTMLInputElement>('wake-name').value = wakeNamePreferences.value.name;
  el('wake-name-fields').hidden = !wakeNamePreferences.value.custom;
  renderWakeState();
}
async function saveWakeName(custom: boolean): Promise<void> {
  if (busy || recorder.state !== 'idle') {
    el('wake-name-status').textContent = t('処理が終わるまでお待ちください。');
    if (!custom) el<HTMLInputElement>('custom-wake-name').checked = wakeNamePreferences.value.custom;
    return;
  }
  const checked = validateWakeName(custom ? el<HTMLInputElement>('wake-name').value : wakeNamePreferences.value.name);
  if (checked.error) {
    el<HTMLInputElement>('wake-name').setAttribute('aria-invalid', 'true');
    el('wake-name-status').textContent = t(checked.error === 'reserved' ? 'その名前は使えません' : '呼び名は英字1〜24文字で入力してください');
    return;
  }
  wakeNameEdited = true;
  el<HTMLInputElement>('wake-name').removeAttribute('aria-invalid');
  const version = ++wakeNameSaveVersion;
  const persistenceVersion = ++wakeNamePersistenceVersion;
  const saved = wakeNamePreferences.save({custom, name: checked.name});
  renderWakeNameControls();
  const applying = recorder.setWakeName(wakeNamePreferences.wakeName);
  updateRuntime();
  const retained = await saved;
  // Draft edits only invalidate their own success message. Persistence failure
  // stays visible independently; a newer save alone supersedes this result.
  if (!exited && persistenceVersion === wakeNamePersistenceVersion) {
    el('wake-name-save-status').textContent = retained ? '' : t('この画面では設定を保存できません。閉じると設定が戻る場合があります。');
  }
  await applying;
  if (exited || version !== wakeNameSaveVersion) return;
  renderWakeState(); updateRuntime();
  el('wake-name-status').textContent = retained ? t('呼び名を保存しました') : '';
}
el<HTMLInputElement>('custom-wake-name').onchange = () => {
  wakeNameEdited = true; wakeNameSaveVersion++;
  const custom = el<HTMLInputElement>('custom-wake-name').checked;
  el('wake-name-status').textContent = '';
  if (!custom) { void saveWakeName(false); return; }
  el('wake-name-fields').hidden = false;
  el('wake-name-status').textContent = t('変更はまだ保存されていません');
  el<HTMLInputElement>('wake-name').focus();
};
el<HTMLInputElement>('wake-name').oninput = () => {
  wakeNameEdited = true; wakeNameSaveVersion++;
  const input = el<HTMLInputElement>('wake-name');
  const reserved = validateWakeName(input.value).error === 'reserved';
  if (reserved) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  el('wake-name-status').textContent = t(reserved ? 'その名前は使えません' : '変更はまだ保存されていません');
};
el<HTMLFormElement>('wake-name-form').onsubmit = event => {
  event.preventDefault(); void saveWakeName(el<HTMLInputElement>('custom-wake-name').checked);
};
renderWakeNameControls();
void recorder.setWakeName(wakeNamePreferences.wakeName);

function recordingHint(): string {
  return operationPreferences.disableHoldRecording ? t('長押し録音は無効です') : t('長押しで録音 · 指を離すと停止');
}
function renderOperationSettings(): void {
  el<HTMLInputElement>('disable-hold-recording').checked = operationPreferences.disableHoldRecording;
  recordButton.disabled = !glassesReady || recorder.state === 'stopping' || (recorder.state === 'idle' && (!operationPreferencesReady || operationPreferences.disableHoldRecording));
  el('recording-hint').textContent = recordingHint();
}
function refreshIdleVoicePrompt(): void {
  renderOperationSettings();
  if (recorder.state === 'idle' && progress.phase === 'idle' && !conversation.selected && !busy) {
    display(() => session.token ? t('G2接続済み') : t('接続設定が必要'), () => session.token ? idleVoicePrompt() : t('スマートフォンで接続設定を開いてください'));
  } else queueDisplayFrame();
}
renderOperationSettings();
el<HTMLInputElement>('disable-hold-recording').onchange = () => {
  const disabled = el<HTMLInputElement>('disable-hold-recording').checked;
  const saved = operationPreferences.saveDisableHoldRecording(disabled);
  if (disabled && recorder.source === 'manual' && recorder.state !== 'idle') {
    discarding = true;
    void recorder.stop(true);
  }
  refreshIdleVoicePrompt();
  void saved.then(saved => {
    if (!exited) el('hold-save-status').textContent = saved ? '' : t('設定を保存できませんでした');
  });
};

el<HTMLInputElement>('wake-word').checked = operationPreferences.wakeWord;
el<HTMLInputElement>('wake-word').onchange = () => {
  const enabled = el<HTMLInputElement>('wake-word').checked;
  const saved = operationPreferences.save(enabled);
  void recorder.setEnabled(enabled).then(() => { if (!exited) refreshIdleVoicePrompt(); });
  void saved.then(saved => {
    if (!exited) el('operation-save-status').textContent = saved ? '' : t('設定を保存できませんでした');
  });
};

function startRecording(fromHold = false): void {
  if (exited || !operationPreferencesReady || operationPreferences.disableHoldRecording) return;
  if (!glassesReady) { notice.textContent = t('G2との接続と起動状態を確認し、Dot Linkを開き直してください。'); return; }
  if (busy) { notice.textContent = t('処理が終わるまでお待ちください。'); return; }
  if (!session.token || !subscribed || progress.connection !== 'online') { notice.textContent = getLanguage() === 'ja' ? `${hostName}とDotへの接続を確認してください。` : `Check the connection to ${hostName} and Dot.`; return; }
  standby?.activity();
  if (playback.active) playback.cancel();
  holdRecording = fromHold;
  void recorder.start();
}
recordButton.onclick = () => recorder.state === 'idle' ? startRecording() : void recorder.stop();
function showDiscarded(): void {
  discarding = false;
  clearClip(); notice.textContent = t('録音を破棄しました。');
  progress.setPhase('idle');
  if (keepWakeConversation()) updateRuntime();
  else if (recorder.source === 'manual' && conversation.selected) showMessage();
  else display(() => t('G2接続済み'), idleVoicePrompt);
  flushPendingDisplay();
}
discardButton.onclick = () => {
  if (transcriptionController) { transcriptionController.abort(); transcriptionController = undefined; busy = false; }
  clearClip();
  if (recorder.state !== 'idle') {
    discarding = true; notice.textContent = t('録音を破棄しました。');
    void recorder.stop(true);
  } else showDiscarded();
};
// A hidden phone page is not an explicit glasses-app exit. Keep the receiver
// and app-level standby alive; physical display power remains OS-owned.
window.addEventListener('pagehide', () => { exitDiagnostics.record('pagehide'); pageActive = false; updateRuntime(false); });
function stopSession(): void {
  if (exited) return;
  exitDiagnostics.record('stop-session');
  void locationSharing.stop();
  exited = true; pageActive = false; session.stop();
  updates.stop(); if (statusTimer) clearInterval(statusTimer); statusTimer = undefined;
  standby?.stop(); void syncHeadRaise();
  runtimeEffects.stop(); playback.stop(); g2Display.stop(); clearClip(); void recorder.dispose();
}

function retireSupersededRuntime(): void {
  if (exited) return;
  runtimeNative.retire();
  exited = true; pageActive = false;
  session.stop(); updates.stop();
  if (statusTimer) clearInterval(statusTimer); statusTimer = undefined;
  if (imuWatchdog) clearTimeout(imuWatchdog); imuWatchdog = undefined;
  transcriptionController?.abort(); transcriptionController = undefined;
  locationSharing.abandon(); standby?.stop(); runtimeEffects.stop();
  g2Display.stop(); playback.stop(false); clearClip(); void recorder.dispose();
  // Keep an unsent text draft selectable; stop controls in the retained page.
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')) control.disabled = true;
  for (const field of document.querySelectorAll<HTMLTextAreaElement>('textarea')) field.readOnly = true;
  el('dot-status').textContent = t('新しい画面へ接続を引き継ぎました');
  notice.textContent = t('この画面は停止しました。続きは新しく開いたDot Linkで行ってください。未送信のテキストはこの画面からコピーできます。');
}
let locationAttached = false;
function attachLocation(): void {
  if (!bridge || exited || locationAttached) return;
  // Do not start shared native location until this runtime has acquired access.
  if (session.token && progress.connection !== 'online') return;
  locationAttached = true;
  void locationSharing.attach(bridge);
}

async function connect(): Promise<void> {
  const appBridge = await waitForEvenAppBridge();
  if (exited) return;
  void exitDiagnostics.attach(runtimeNative.storage(appBridge));
  void restoreRelay(appBridge).then(() => attachLocation());
  const nativeStorage = runtimeNative.storage(appBridge);
  void languagePreferences.attach(nativeStorage).then(() => { if (!exited) applyLanguage(); });
  bridge = appBridge;
  startupStage = 'page';
  el('g2-diagnostic').textContent = 'G2_STARTUP_PENDING';
  const result = await appBridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 6,
    textObject: [
      new TextContainerProperty({ containerID: 1, containerName: 'status', xPosition: 8, yPosition: 8,
        width: 215, height: 36, content: 'Dot Link' }),
      new TextContainerProperty({ containerID: 2, containerName: 'conversation', xPosition: 8, yPosition: 50,
        width: 560, height: 130, isEventCapture: 1, content: t('接続を確認中') }),
      new TextContainerProperty({ containerID: 3, containerName: 'help', xPosition: 8, yPosition: 244,
        width: 560, height: 36, content: recordingHint() }),
      new TextContainerProperty({ containerID: 4, containerName: 'speech', xPosition: 8, yPosition: 188,
        width: 560, height: 52, content: speechDisplayCaption() }),
      new TextContainerProperty({ containerID: 5, containerName: 'receipt', xPosition: 422, yPosition: 8,
        width: 146, height: 36, content: ' ' }),
      new TextContainerProperty({ containerID: 6, containerName: 'new', xPosition: 245, yPosition: 8,
        width: 145, height: 36, content: ' ' }),
    ],
  }));
  if (exited) return;
  startupResult = result;
  if (result !== 0) throw new Error('Glasses page initialization failed');
  startupStage = 'ready'; glassesReady = true; syncRuntimeEffects();
  void readAloudPreferences.attach(nativeStorage).then(() => {
    if (exited) return;
    const wasEnabled = tts;
    tts = readAloudPreferences.value;
    renderReadAloudControl();
    if (wasEnabled && !tts) playback.cancel();
    updateRuntime();
  });
  exitDiagnostics.record('ready');
  void Promise.all([operationPreferences.attach(nativeStorage), wakeNamePreferences.attach(nativeStorage)]).then(async () => {
    if (exited) return;
    operationPreferencesReady = true;
    if (operationPreferences.disableHoldRecording && recorder.source === 'manual' && recorder.state !== 'idle') {
      discarding = true; void recorder.stop(true);
    }
    refreshIdleVoicePrompt();
    // Preserve an explicitly marked unsaved draft; the wake label below uses
    // the restored active name until the user saves the draft.
    if (!wakeNameEdited) renderWakeNameControls();
    await recorder.setWakeName(wakeNamePreferences.wakeName);
    if (exited) return;
    renderWakeState(); updateRuntime();
    el<HTMLInputElement>('wake-word').checked = operationPreferences.wakeWord;
    await recorder.setEnabled(operationPreferences.wakeWord);
    if (!exited) refreshIdleVoicePrompt();
  });
  standby?.start();
  void syncHeadRaise();
  void displayPreferences.attach(nativeStorage).then(restored => {
    if (exited) return;
    if (restored) applyDisplayPreferences();
    else void syncHeadRaise();
  });
  el('g2-diagnostic').textContent = 'G2_READY';
  g2Display.invalidate();
  connection.textContent = t('Even Hub接続済み');
  notice.textContent = '';
  renderOperationSettings();
  // History may finish loading before the Even bridge is ready. Repaint it
  // now: later polls with unchanged history otherwise never update the G2.
  if (conversation.selected) {
    showMessage();
  } else {
    display(() => session.token ? t('G2接続済み') : t('接続設定が必要'), () => session.token ? idleVoicePrompt() : t('スマートフォンで接続設定を開いてください'));
  }
  appBridge.onEvenHubEvent(event => {
    exitDiagnostics.observe(event, exited);
    if (exited) return;
    if (event.audioEvent && event.audioEvent.source !== AudioInputSource.Phone) recorder.append(event.audioEvent.audioPcm);
    const eventType = event.sysEvent?.eventType ?? event.textEvent?.eventType ?? event.listEvent?.eventType;
    if (eventType === OsEventTypeList.SYSTEM_EXIT_EVENT) exitDiagnostics.record('system-exit');
    if (eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT) exitDiagnostics.record('abnormal-exit');
    if (eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) exitDiagnostics.record('foreground-enter');
    if (eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) exitDiagnostics.record('foreground-exit');
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
    // Ignore both edges before waking the display or touching any recording.
    if ((eventType === OsEventTypeList.LONG_PRESS_EVENT || eventType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT)
      && (!operationPreferencesReady || operationPreferences.disableHoldRecording)) return;
    if (isSingle || eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      if (standby?.tap(isSingle ? 'single' : 'double')) return;
    } else if (standby?.hidden && eventType !== OsEventTypeList.LONG_PRESS_EVENT && eventType !== OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return;
    if (hasInput) standby?.activity();
    if (eventType === OsEventTypeList.LONG_PRESS_EVENT) startRecording(true);
    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) el('previous').click();
    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) el('next').click();
    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      exitDiagnostics.record('dialog-request');
      void appBridge.shutDownPageContainer(1).then(ok => { exitDiagnostics.record(ok ? 'dialog-opened' : 'dialog-failed'); if (!ok) notice.textContent = t('終了確認を開けませんでした'); }).catch(() => { exitDiagnostics.record('dialog-failed'); notice.textContent = t('終了確認を開けませんでした'); });
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
    if (!bridge || !runtimeNative.active || enabled === imuActive) return;
    if (imuWatchdog) clearTimeout(imuWatchdog);
    headRaise.reset(); headStatusAt = -Infinity;
    if (enabled) el('head-raise-status').textContent = t('頭の動きを確認しています…');
    try {
      const ok = await runtimeNative.control(() => bridge!.imuControl(enabled, ImuReportPace.P200));
      if (!runtimeNative.active) return;
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
  refreshStatus(false); queueDisplayFrame();
});
initializeDisplaySettings();
renderLocationStatus();
showSetup(!session.token);
if (session.token && !session.credentials?.resumeToken) updates.start(true);
updateRuntime(false);
window.addEventListener('pageshow', event => { exitDiagnostics.record('pageshow'); if (exited) return; pageActive = true; standby?.check(); updateRuntime(); if (event.persisted && session.token && relayRestored) updates.start(); });
window.addEventListener('online', () => { if (session.token && relayRestored && !exited) updates.start(); });
window.addEventListener('offline', () => { if (exited) return; progress.connection = 'offline'; updateRuntime(); el('dot-status').textContent = `${hostName} · ${t('切断')}`; });
document.addEventListener('visibilitychange', () => { exitDiagnostics.record(document.hidden ? 'hidden' : 'visible'); if (exited) return; standby?.check(); updateRuntime(); if (!document.hidden && session.token && relayRestored) updates.start(); });

void connect().catch(() => {
  if (exited) return;
  const nativeReady = startupStage !== 'bridge';
  connection.textContent = nativeReady ? t('G2の画面を起動できませんでした') : t('Evenアプリとの接続準備ができませんでした');
  notice.textContent = nativeReady ? t('G2との接続と起動状態を確認し、Dot Linkを開き直してください。') : t('Evenアプリとの接続準備ができていません。アプリを閉じて開き直してください。');
  el('g2-diagnostic').textContent = nativeReady ? `G2_STARTUP_${startupResult ?? 'REQUEST_FAILED'}` : 'EVEN_BRIDGE_UNAVAILABLE';
});
