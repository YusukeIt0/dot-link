import { DisconnectJournal, DisconnectRetry } from './disconnect-journal.ts';
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
import { conversationText, conversationHudText, receiptCaption, newReplyCaption } from './conversation-display.ts';
import { wrapHudText } from './hud-text.ts';
import { withoutMessageUrls } from './message-links.ts';
import { LiveUpdates } from './live-updates.ts';
import { Pairing } from './pairing.ts';
import { InteractionStatus } from './interaction-status.ts';
import { DisplayStandby, HeadRaiseDetector, type DisplayPreferences } from './display-standby.ts';
import { DisplayPreferenceStore } from './display-preferences.ts';
import { t, getLanguage, setLanguage, chooseLanguage, translateLabel, speechLocale, supportedLanguages, languageName, message, type TranslationKey } from './i18n.ts';
import { RelaySettings, PendingUtterance } from './relay-connection.ts';
import { selectPhoto, MAX_PHOTOS, type PhotoAttachment } from './photo-attachments.ts';
import { parseInvite, type PairingInvite } from './relay-origin.ts';
import { LanguagePreferences, isLanguagePreference } from './language-preferences.ts';
import { LocationSharing, type LocationRelayStatus } from './location-sharing.ts';
import { installKeyboardViewport } from './keyboard-viewport.ts';
import { installTranscriptSize } from './transcript-size.ts';
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
const staticLabels = [...document.querySelectorAll<HTMLElement>('[data-i18n]')].map(element => ({
  element, key: element.dataset.i18n as TranslationKey,
}));
setLanguage(chooseLanguage(navigator.language, languagePreferences.value));
document.documentElement.lang = getLanguage();
for (const { element, key } of staticLabels) element.textContent = t(key);
function renderStaticAccessibility(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    const key = element.dataset.i18nAriaLabel as TranslationKey | undefined;
    if (key) element.setAttribute('aria-label', t(key));
  }
}
renderStaticAccessibility();

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
const photos: PhotoAttachment[] = [];
let photoRevision = 0;
let photoSelecting = false;
let photosSupported = false;
const transcript = el<HTMLTextAreaElement>('transcript');
const resizeTranscript = installTranscriptSize(transcript, document.querySelector<HTMLElement>('main')!);
const pairingInput = el<HTMLTextAreaElement>('pair-code');
const disconnectJournal = new DisconnectJournal(() => localStorage);
let disconnectRestoreReady = false;
let explicitConnection = false;
let pairingExchange = false;
let disconnectRestoreFailures = 0;
let relayRestoreFlight: Promise<void> | undefined;
let disconnectRestoreTimer: ReturnType<typeof setTimeout> | undefined;
let showDisconnectState = disconnectJournal.pending.length > 0;
const relaySettings = new RelaySettings(() => localStorage);
const pairing = new Pairing(() => localStorage, () => sessionStorage);
const runtimeNative = new RuntimeNative();
const session = new RelaySession({
  settings: relaySettings, legacyToken: pairing.read(), appOrigin: location.origin,
  fetch: (input, init) => fetch(input, init),
  rejected: reason => forgetPairing(reason === 'expired'
    ? t('even.pairing_expired_or_was_revoked_on_your_mac_connect_using')
    : t('even.pairing_has_expired_or_been_revoked_create_a_new_pairing')),
  superseded: () => retireSupersededRuntime(),
  persistenceFailed: () => { notice.textContent = t('even.could_not_confirm_saving_pairing_in_even_you_may_need'); },
});
if (session.credentials && disconnectJournal.blocks(session.credentials)) session.use(undefined);
const disconnectRetry = new DisconnectRetry({
  journal: disconnectJournal, fetch: (input, init) => fetch(input, init),
  durable: () => { if (!session.token) relaySettings.forget(); },
  changed: ({ pending, durable }) => {
    if (exited || session.token || !showDisconnectState) return;
    if (!pending) relaySettings.forget();
    pairingNotice.textContent = !pending ? t('even.pairing_revoked_and_removed') : durable
      ? t('even.stopped_on_this_device_removal_on_your_mac_will_complete')
      : t('even.stopped_on_this_device_but_the_disconnect_could_not_be');
  },
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
    status.textContent = t('even.url_copied_open_it_in_a_browser_on_your_mac');
    showCopyToast(t('even.copied'));
  } catch {
    status.textContent = t('even.could_not_copy_enter_the_displayed_url_in_your_mac');
    showCopyToast(t('even.could_not_copy'));
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
const language = el<HTMLSelectElement>('language');
function renderLanguageOptions(): void {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  language.innerHTML = `<option value="auto">${escape(t('even.automatic'))}</option>` + supportedLanguages.map(locale => `<option value="${locale}">${escape(languageName(locale))}</option>`).join('');
  language.value = languagePreferences.value;
}
renderLanguageOptions();
renderPhoneLabels();
renderRecordControl('idle');
language.onchange = () => {
  if (busy || recorder.state !== 'idle') { language.value = languagePreferences.value; notice.textContent = t('even.please_wait_for_the_current_task_to_finish'); return; }
  if (!isLanguagePreference(language.value) || language.value === languagePreferences.value) return;
  setReadAloud(false);
  void languagePreferences.save(language.value).then(saved => {
    if (!saved && !exited) notice.textContent = t('even.settings_could_not_be_saved_here_they_may_reset_when');
  });
  applyLanguage();
};
const progress = new InteractionStatus();
progress.connection = session.token ? 'connecting' : 'unpaired';
let hostName = t('even.relay');
let namedHost = false;
let baseStatus = t('even.hold_to_speak');
let renderBaseStatus: () => string = () => t('even.hold_to_speak');
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
  const s = locationSharing.status();
  el<HTMLInputElement>('location-share').checked = s.enabled;
  el<HTMLInputElement>('mobility-share').checked=s.mobility;
  el<HTMLInputElement>('mobility-share').disabled=!s.enabled&&!s.mobility;
  const labels = {
    off: 'even.not_sharing', starting: 'even.starting_location_sharing',
    waiting: 'even.waiting_for_a_current_location', sharing: 'even.sharing_your_current_location',
    stale: 'even.waiting_for_a_fresh_location',
    unavailable: 'even.location_is_unavailable_check_location_permission_for_the_even_app',
    offline: 'even.reconnecting_location_sharing_to_your_mac',
    stopping: 'even.sharing_has_stopped_on_this_device_waiting_to_confirm_the',
  } as const;
  el('location-status').textContent = t(labels[s.state]) + (!s.saved ? (t('even.settings_could_not_be_saved')) : '');
  el('location-dot-status').textContent = !s.enabled ? '' : s.dotSubscribed ?
    (t('even.dot_is_ready_to_receive_location_changes_and_decide_whether')) :
    (t('even.waiting_for_dot_to_connect_to_location_sharing'));
  el('location-diagnostic').textContent = `${t('even.location')}: ${s.state} · ${t('even.received')} ${s.receivedCount ?? 0} · ${t('even.announcements')} ${s.announcementCount ?? 0}${s.accuracy === undefined ? '' : ` · ±${Math.round(s.accuracy)}m`}${s.receivedAt ? ` · ${new Date(s.receivedAt).toLocaleTimeString()}` : ''}`;
}
el<HTMLInputElement>('location-share').onchange = () => locationSharing.setEnabled(el<HTMLInputElement>('location-share').checked);
el<HTMLInputElement>('mobility-share').onchange = () => locationSharing.setMobilityEnabled(el<HTMLInputElement>('mobility-share').checked);
const connectionTransitions = new ConnectionTransitions({
  session,
  stopUpdates: () => updates.stop(), cancelPlayback: () => playback.cancel(),
  stopLocation: () => locationSharing.setEnabled(false), clearLegacyPairing: () => pairing.forget(),
  resetInteraction: (pairing, newIdentity) => {
    transcriptionController?.abort(); transcriptionController = undefined;
    photoRevision++; photoSelecting = false;
    busy = pairing; clearClip(); audioTraceId = undefined; discarding = false;
    el<HTMLButtonElement>('pair').disabled = pairing; sendButton.disabled = pairing || !transcript.value.trim();
    if (newIdentity) { progress.reset(); timing.reset(); } else progress.setPhase('idle');
  },
  resetConversation: () => conversation.reset(),
  resetDelivery: (origin, clearRetry) => {
    pendingDelivery = new PendingUtterance(() => localStorage, origin ?? location.origin);
    if (clearRetry) { pendingId = undefined; pendingText = undefined; clearPhotos(); }
  },
  resetConnectionInfo: () => {
    subscribed = false; photosSupported = false; progress.dotConnected = false;
    hostName = t('even.relay'); namedHost = false; selectedSTT = readSTTProvider(undefined); selectedSTTModel = undefined;
  },
});
function forgetPairing(message: string, persist = true): void {
  connectionTransitions.forget(persist);
  pairingInput.value = ''; offeredInvite = undefined;
  showSetup(true);
  progress.connection = 'unpaired'; syncRuntimeEffects();
  display(() => t('even.reconnect_your_mac'), message);
  el('dot-status').textContent = t('even.reconnect_your_mac');
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

function restoreRelay(appBridge: EvenAppBridge): Promise<void> {
  if (relayRestoreFlight) return relayRestoreFlight;
  const operation = restoreRelayAttempt(appBridge).then(() => { if (relayRestored && !exited) attachLocation(); }).finally(() => { if (relayRestoreFlight === operation) relayRestoreFlight = undefined; });
  relayRestoreFlight = operation;
  return operation;
}
async function restoreRelayAttempt(appBridge: EvenAppBridge): Promise<void> {
  const version = session.version;
  clearTimeout(disconnectRestoreTimer);
  const ready = await disconnectJournal.attach(runtimeNative.storage(appBridge));
  if (exited) return;
  if (version !== session.version) {
    disconnectRestoreTimer = setTimeout(() => { void restoreRelay(appBridge); }, 0);
    return;
  }
  if (!ready) {
    if (!explicitConnection) {
      relayRestored = false;
      connectionTransitions.beginPairing();
      progress.connection = 'connecting'; syncRuntimeEffects();
      pairingNotice.textContent = t('even.could_not_verify_saved_connection_settings_retrying_before_restoring_the');
    }
    const delay = Math.min(10000, 2000 * 2 ** Math.min(disconnectRestoreFailures++, 3));
    disconnectRestoreTimer = setTimeout(() => { void restoreRelay(appBridge); }, delay);
    return;
  }
  const wasSuspended = disconnectRestoreFailures > 0;
  disconnectRestoreFailures = 0;
  disconnectRestoreReady = true;
  // A freshly issued pairing cannot match an older disconnect entry. Never
  // replace an explicit connection with credentials read later from storage.
  if (explicitConnection) {
    if (disconnectJournal.pending.length) void disconnectRetry.run();
    return;
  }
  let saved = await relaySettings.attach(runtimeNative.storage(appBridge));
  if (version !== session.version || exited) return;
  relayRestored = true;
  if (pairingNotice.textContent === t('even.could_not_verify_saved_connection_settings_retrying_before_restoring_the')) pairingNotice.textContent = '';
  if (saved && disconnectJournal.blocks(saved)) saved = undefined;
  if (disconnectJournal.pending.length) {
    showDisconnectState = true;
    if (!saved) forgetPairing(t('even.stopped_on_this_device_removal_on_your_mac_will_complete'), false);
    void disconnectRetry.run();
  }
  // Legacy development credentials are separate from packaged pairing.
  if (!saved && !session.credentials) {
    if (wasSuspended && session.token) updates.start(true);
    syncRuntimeEffects();
    return;
  }
  connectionTransitions.restore(saved);
  if (!saved) { showSetup(true); progress.connection = 'unpaired'; syncRuntimeEffects(); display(() => t('even.reconnect_your_mac'), () => t('even.check_the_mac_address_below_then_tap_connect')); return; }
  showSetup(false); progress.connection = 'connecting'; syncRuntimeEffects(); display(() => t('even.reconnecting'), idleVoicePrompt);
  updates.start(true);
}

async function api<T>(path: string, method = 'GET', body?: string | Uint8Array, trace?: string, requestSignal?: AbortSignal): Promise<T> {
  if (!relayRestored) throw new Error(t('even.connecting'));
  const version = session.version;
  const current = () => { if (exited || !session.isCurrent(version)) throw new Error('Connection changed'); };
  const response = await session.request(path, method, body, trace, requestSignal);
  current();
  if (!response.ok && path === '/api/utterances' && response.status === 422) {
    const failure = await response.json().catch(() => ({})); current();
    throw new Error(failure.code === 'PHOTO_STORAGE_FULL' ? t('even.photos_waiting_for_dot') : t('even.could_not_complete_the_request_check_the_connection_or_recording'));
  }
  if (!response.ok && path === '/api/transcribe' && response.status === 422) {
    const failure = await response.json().catch(() => ({})); current();
    throw new Error(sttErrorMessage(failure.code) ?? t('even.could_not_complete_the_request_check_the_connection_or_recording'));
  }
  if (!response.ok) throw new Error(response.status === 401 && !session.credentials?.resumeToken ? t('even.create_a_new_pairing_code_on_your_mac_and_paste') : t('even.could_not_complete_the_request_check_the_connection_or_recording'));
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
    return item.reply || item.photosExpired ? `${conversation.position(item.id)}/${conversation.count}` :
      item.status === 'failed' ? t('even.delivery_unconfirmed') : t('even.waiting_for_name', { name: wakeNamePreferences.assistantName });
  }, () => conversationText(current(), Date.now(), wakeNamePreferences.assistantName), message.id,
    () => conversationHudText(current(), Date.now(), wakeNamePreferences.assistantName));
}
function currentReceipt(): string { return receiptCaption(conversation.visible); }
function currentNewReplies(): string { return newReplyCaption(conversation.unreadCount); }

interface Snapshot { revision: string; status: { subscribed: boolean; photoAttachments?: number; deviceName?: string; sttProvider?: unknown; sttModel?: unknown } & LocationRelayStatus; messages: Message[]; }
function receiveUpdate(snapshot: Snapshot, initial = false): void {
  if (exited) return;
  locationSharing.receive(snapshot.status);
  subscribed = snapshot.status.subscribed;
  photosSupported = snapshot.status.photoAttachments === 1;
  selectedSTT = readSTTProvider(snapshot.status.sttProvider);
  selectedSTTModel = snapshot.status.sttModel;
  progress.connection = 'online'; progress.dotConnected = subscribed; attachLocation();
  if (snapshot.status.deviceName) { hostName = snapshot.status.deviceName; namedHost = true; }
  const update = conversation.receive(snapshot.messages, initial, message => locationSharing.acceptsAnnouncement(message));
  for (const message of snapshot.messages) {
    // A stored answer completes the request even when consent/freshness blocks
    // its announcement. Completion must not wake the display or start speech.
    if (message.reply) progress.complete(message.id);
    else if (message.photosExpired) progress.stopWaiting(message.id);
  }
  for (const message of update.announcements) {
    timing.mark(message.id, 'reply_received');
    const spokenText = withoutMessageUrls(message.reply ?? '');
    if (tts && spokenText && 'speechSynthesis' in window) {
      const speech = new SpeechSynthesisUtterance(spokenText); speech.lang = speechLocale();
      playback.speak(speech);
    }
  }
  if (update.waiting) progress.restoreWaiting(update.waiting.id, update.waiting.createdAt, Date.now());
  el('dot-status').textContent = `${hostName} · ${subscribed ? t('even.dot_connected') : t('even.dot_disconnected')}`;
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
  el('dot-status').textContent = `${hostName} · ${t('even.reconnecting')}`;
});

function offerInvite(raw: string): void {
  offeredInvite = parseInvite(raw);
  el('pair-destination').textContent = offeredInvite.origin;
  el('pair').hidden = false;
  pairingNotice.textContent = t('even.check_the_mac_address_below_then_tap_connect');
}
pairingInput.oninput = () => {
  offeredInvite = undefined; el('pair-destination').textContent = ''; el('pair').hidden = true;
  try { offerInvite(pairingInput.value); } catch { pairingNotice.textContent = t('even.the_pairing_code_is_invalid_or_expired_create_a_new'); }
};
el('pair').onclick = async () => {
  if (busy || recorder.state !== 'idle' || exited) return;
  let invite: PairingInvite;
  try { invite = parseInvite(offeredInvite ? JSON.stringify(offeredInvite) : pairingInput.value); }
  catch { pairingNotice.textContent = t('even.copy_the_pairing_code_on_your_mac_and_paste_the'); return; }
  explicitConnection = true; pairingExchange = true;
  el<HTMLButtonElement>('forget-pairing').disabled = true;
  busy = true; const button = el<HTMLButtonElement>('pair'); button.disabled = true;
  connectionTransitions.beginPairing();
  const version = session.version;
  progress.connection = 'connecting'; updateRuntime();
  let accepted = false;
  try {
    const credentials = await session.pair(invite);
    if (version !== session.version || exited) return;
    if (bridge) relaySettings.connectNative(runtimeNative.storage(bridge));
    const retained = connectionTransitions.paired(credentials); accepted = true; relayRestored = true;
    const snapshot = await api<Snapshot>('/api/updates'); receiveUpdate(snapshot, true); updates.start(false, snapshot.revision);
    pairingInput.value = ''; offeredInvite = undefined;
    const nativeRetained = await relaySettings.nativeSaved();
    if (version !== session.version || exited) return;
    pairingNotice.textContent = '';
    notice.textContent = nativeRetained && credentials.resumeToken ? t('even.connected_update_recovery_details_are_saved_too') : retained ? t('even.connected_automatic_recovery_after_an_update_is_not_verified') : t('even.connected_but_storage_is_unavailable_pair_again_after_closing_the');
    el('diagnostic').textContent = t('even.connection_verified');
    showSetup(false);
  } catch (error) {
    if (version !== session.version || exited) return;
    if (!accepted) explicitConnection = false;
    progress.connection = session.token ? 'offline' : 'unpaired'; updateRuntime();
    setupPanel.open = true;
    pairingNotice.textContent = t('even.your_mac_must_be_awake_and_online');
    el('diagnostic').textContent = t('even.check_tailscale_your_mac_and_code_expiry');
    if (session.token && relayRestored) updates.start(true);
  } finally { pairingExchange = false; el<HTMLButtonElement>('forget-pairing').disabled = false; if (!exited && session.isCurrent(version)) { busy = false; button.disabled = false; sendButton.disabled = !transcript.value.trim(); flushPendingDisplay(); } }
};
el('forget-pairing').onclick = () => {
  if (exited || pairingExchange) return;
  const credentials = session.credentials;
  if (credentials) disconnectJournal.add(credentials);
  showDisconnectState = true;
  forgetPairing(credentials ? t('even.stopped_on_this_device_confirming_removal_on_your_mac') : t('even.connection_settings_were_removed_from_this_device_mac_side_removal'), !credentials);
  busy = false;
  display(() => t('even.pair_with_your_mac'), () => t('even.open_setup_on_your_phone'));
  if (credentials) void disconnectRetry.run();
};
function setReadAloud(enabled: boolean): void {
  tts = enabled; renderReadAloudControl();
  void readAloudPreferences.save(tts).then(saved => {
    if (!saved && !exited) notice.textContent = t('even.settings_could_not_be_saved_here_they_may_reset_when');
  });
  if (tts && 'speechSynthesis' in window) { const speech = new SpeechSynthesisUtterance(t('even.read_aloud_is_on')); speech.lang = speechLocale(); playback.speak(speech); }
  else playback.cancel();
  updateRuntime();
}
el('tts').onclick = () => setReadAloud(!tts);
el('previous').onclick = () => { standby?.activity(); conversation.navigate(-1); showMessage(); };
el('next').onclick = () => { standby?.activity(); conversation.navigate(1); showMessage(); };
let pendingId: string | undefined;
let pendingText: string | undefined;
function clearPhotos(): void { photoRevision++; photos.length = 0; photoSelecting = false; renderPhotos(); }
function renderPhotos(): void {
  const container = el('photo-previews'); container.textContent = '';
  for (const [index, photo] of photos.entries()) {
    const item = document.createElement('div'); item.className = 'photo-preview';
    const image = document.createElement('img'); image.src = `data:${photo.mimeType};base64,${photo.data}`;
    image.alt = t('even.photo_number', { count: index + 1 });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'photo-remove'; remove.textContent = '×';
    remove.setAttribute('aria-label', t('even.remove_photo_number', { count: index + 1 })); remove.disabled = busy;
    remove.onclick = () => { if (busy || exited) return; photos.splice(index, 1); photoRevision++; renderPhotos(); updateRuntime(false); };
    item.append(image, remove); container.append(item);
  }
}
async function choosePhoto(source: 'camera' | 'album'): Promise<void> {
  if (exited || busy || recorder.state !== 'idle' || !bridge || !session.token) return;
  if (!photosSupported) { notice.textContent = t('even.update_mac_for_photos'); return; }
  if (photos.length >= MAX_PHOTOS) { notice.textContent = t('even.photo_limit', { count: MAX_PHOTOS }); return; }
  const version = session.version, revision = photoRevision;
  busy = true; photoSelecting = true; notice.textContent = ''; standby?.activity(); updateRuntime(false);
  try {
    const photo = await selectPhoto(source, bridge);
    if (exited || !session.isCurrent(version) || revision !== photoRevision) return;
    if (photo) {
      if (photos.some(existing => existing.data === photo.data)) notice.textContent = t('even.photo_already_added');
      else { photos.push(photo); photoRevision++; }
    }
  } catch {
    if (!exited && session.isCurrent(version)) notice.textContent = t('even.photo_unavailable');
  } finally {
    if (!exited && session.isCurrent(version)) { busy = false; photoSelecting = false; renderPhotos(); updateRuntime(false); }
  }
}
el('camera').onclick = () => void choosePhoto('camera');
el('photos').onclick = () => void choosePhoto('album');
sendButton.onclick = async () => {
  const text = transcript.value.trim(); if ((!text && !photos.length) || busy || recorder.state !== 'idle' || !session.token || exited) return;
  if (photos.length && !photosSupported) { notice.textContent = t('even.update_mac_for_photos'); return; }
  const attachments = photos.slice();
  const identity = attachments.length ? JSON.stringify({ text, photos: attachments }) : text;
  standby?.activity();
  busy = true; sendButton.disabled = true;
  updateRuntime(false);
  const version = session.version;
  try {
    if (pendingText !== identity) {
      const preparedId = await pendingDelivery.prepare(identity, audioTraceId);
      if (exited || !session.isCurrent(version)) return;
      pendingId = preparedId; pendingText = identity; audioTraceId = undefined;
    }
    if (version !== session.version || exited) return;
    progress.begin(pendingId!, 'sending'); updateRuntime();
    timing.mark(pendingId!, 'utterance_sent');
    const message = await api<Message>('/api/utterances', 'POST', JSON.stringify({id:pendingId,text, ...(attachments.length ? {photos: attachments} : {})}));
    timing.mark(pendingId!, 'utterance_accepted');
    reportTiming(pendingId!);
    if (message.photosExpired && !message.reply) {
      // The old delivery can no longer expose its images. A later explicit Send gets a new ID.
      pendingDelivery.clear(); pendingId = undefined; pendingText = undefined;
      throw new Error(t('even.photos_expired_resend'));
    }
    if (message.status === 'failed') throw new Error(t('even.delivery_was_not_confirmed_retrying_the_same_message_will_not'));
    progress.waiting(message.id, message.createdAt, Date.now());
    pendingDelivery.clear();
    transcript.value = ''; resizeTranscript(); pendingId = undefined; pendingText = undefined; clearPhotos();
    if (conversation.acceptSent(message).reply) progress.complete(message.id);
    showMessage();
    notice.textContent = '';
  } catch (error) {
    if (version !== session.version || exited) return;
    progress.setPhase('error'); notice.textContent = (error as Error).message;
    display(() => t('even.delivery_not_confirmed'), (error as Error).message);
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
let lastDisplayText = t('even.hold_to_speak');
let renderDisplayText: () => string = () => t('even.hold_to_speak');
let renderG2Text: () => string = () => withoutMessageUrls(renderDisplayText());

function syncRuntimeEffects(): void {
  runtimeEffects.sync();
  const disabled = exited || busy || recorder.state !== 'idle' || !bridge || !session.token || !relayRestored;
  el<HTMLButtonElement>('camera').disabled = disabled;
  el<HTMLButtonElement>('photos').disabled = disabled;
  sendButton.disabled = exited || busy || recorder.state !== 'idle' || (!transcript.value.trim() && !photos.length);
  for (const button of el('photo-previews').querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy || exited;
}
function updateRuntime(sendToG2 = true): void {
  syncRuntimeEffects(); refreshStatus(sendToG2);
}
function hudCaption(): string {
  return recorder.source === 'wake' && recorder.state === 'recording' ? t('even.go_ahead') : progress.caption(baseStatus, conversation.visibleId, wakeNamePreferences.assistantName);
}
function keepWakeConversation(): boolean {
  return recorder.source === 'wake' && !!conversation.visible;
}
function idleVoicePrompt(): string {
  const wake = operationPreferences.wakeWord && wakeState === 'listening';
  if (operationPreferences.disableHoldRecording) return wake ? wakeText('even.ready_for_wake') : t('even.type_a_message_on_your_phone');
  return wake ? wakeText('even.say_wake_or_hold_to_speak') : t('even.hold_to_speak');
}
function wakeText(key: Parameters<typeof t>[0]): string { return t(key, { wake: `Hey ${wakeNamePreferences.wakeName}` }); }
function renderWakeState(): void {
  const labels = { off: '', loading: wakeText('even.preparing_wake'), listening: '',
    paused: wakeText('even.wake_is_paused'), error: wakeText('even.wake_is_unavailable_turn_it_off_and_on_to_retry') };
  el('wake-status').textContent = labels[wakeState];
}
const playback = new SpeechPlayback({
  synthesis: () => window.speechSynthesis,
  canSpeak: () => recorder.state === 'idle' && !busy,
  changed: () => syncRuntimeEffects(),
  failed: () => { notice.textContent = t('even.read_aloud_failed_please_read_the_reply_on_screen'); },
  now: () => performance.now(), schedule: (callback, ms) => setTimeout(callback, ms), cancelTimer: timer => clearTimeout(timer),
});
const g2Display = new G2Display({
  ready: () => !!bridge && glassesReady,
  hidden: () => standby?.hidden ?? false,
  frame: () => ({status: hudCaption(), conversation: wrapHudText(renderG2Text()),
    help: recordingHint(), speech: speechDisplayCaption(), receipt: currentReceipt(), newReplies: currentNewReplies()}),
  writer: () => {
    const activeBridge = bridge!;
    return (containerID, containerName, content) => activeBridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID, containerName, contentOffset: 0, contentLength: content.length, content,
    }));
  },
  failed: kind => {
    if (kind === 'status') connection.textContent = t('even.could_not_confirm_the_g2_display_update');
    else notice.textContent = t('even.could_not_update_the_g2_display_check_the_connection');
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
  transcript.placeholder = t('even.message_dot');
  phoneLabel('transcript', t('even.message_to_dot'));
  phoneLabel('previous', t('even.previous_conversation'));
  phoneLabel('next', t('even.next_conversation'));
  phoneLabel('discard', t('even.discard_recording'));
  phoneLabel('send', t('even.send_to_dot'));
  phoneLabel('camera', t('even.take_photo'));
  phoneLabel('photos', t('even.choose_photo'));
}
function renderRecordControl(state: VoiceInput['state']): void {
  recordButton.dataset.recordState = state;
  phoneLabel('record', state === 'idle' ? t('even.start_recording') : state === 'stop-error' ? t('even.retry_stopping_the_microphone') : t('even.stop_recording'));
}
function renderReadAloudControl(): void {
  el('tts').setAttribute('aria-pressed', String(tts));
  phoneLabel('tts', `${t('even.read_aloud')} ${tts ? 'ON' : 'OFF'}`);
}
function renderPhoneStatus(): void {
  const selected = conversation.selected;
  const position = `${selected ? conversation.position(selected.id) : 0} / ${conversation.count}`;
  const counter = el('conversation-position');
  if (counter.textContent !== position) counter.textContent = position;
  const state = recorder.state;
  const status = state === 'stop-error' ? t('even.retry_stopping_the_microphone') : state === 'stopping' ? t('even.stopping_microphone') :
    state === 'starting' ? t('even.starting_microphone') : state === 'recording' ? `${t('even.recording')} · ${t('even.use_the_recording_button_to_stop')}` :
    progress.phase === 'recognizing' ? t('even.transcribing') : progress.phase === 'sending' ? t('even.sending') :
    photoSelecting ? t('even.choosing_photo') : photos.length ? t('even.photos_ready') : '';
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

function display(state: string | (() => string), text: string | (() => string), trace?: string, g2Text?: () => string): void {
  if (exited) return;
  renderBaseStatus = typeof state === 'function' ? state : () => state;
  renderDisplayText = typeof text === 'function' ? text : () => text;
  renderG2Text = g2Text ?? (() => withoutMessageUrls(renderDisplayText()));
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
  renderLanguageOptions();
  renderStaticAccessibility();
  renderLocationStatus();
  for (const { element, key } of staticLabels) {
    // Runtime status/controls may have replaced the initial label.
    if (supportedLanguages.some(locale => element.textContent === message(key, locale))) element.textContent = t(key);
  }
  for (const id of ['connection', 'notice', 'pair-notice', 'display-settings-status', 'head-raise-status', 'mac-copy-status', 'copy-toast', 'wake-name-status', 'wake-name-save-status', 'hold-save-status', 'diagnostic']) {
    const element = el(id); element.textContent = translateLabel(element.textContent ?? '');
  }
  renderPhoneLabels(); renderRecordControl(recorder.state); renderPhotos();
  renderWakeState(); renderOperationSettings();
  renderReadAloudControl();
  if (!namedHost) hostName = t('even.relay');
  el('dot-status').textContent = `${hostName} · ${progress.connection === 'online' ? (subscribed ? t('even.dot_connected') : t('even.dot_disconnected')) : progress.connection === 'unpaired' ? t('even.pair_with_your_mac') : t('even.reconnecting')}`;
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
    else display(() => t('even.transcribing'), () => t('even.host_processing', { host: hostName }));
    const trace = audioTraceId;
    timing.mark(trace, 'asr_sent');
    void api<{text:string}>('/api/transcribe', 'POST', wav, trace, controller.signal).then(result => {
      if (exited || version !== session.version || controller.signal.aborted) return;
      timing.mark(trace, 'asr_received');
      const text = source === 'wake' ? wakeTranscript(result.text, capturedWakeName) : result.text;
      if (!text.trim()) {
        busy = false; clearClip(); progress.setPhase('idle');
        if (keepWakeConversation()) updateRuntime();
        else display(() => t('even.g2_connected'), idleVoicePrompt);
        flushPendingDisplay();
        return;
      }
      transcript.value = text; resizeTranscript(); sendButton.disabled = false;
      progress.review(); notice.textContent = '';
      display(() => t('even.transcribed'), text);
      busy = false; clearClip();
      if (el<HTMLInputElement>('auto-send').checked) sendButton.click();
      else flushPendingDisplay();
      updateRuntime();
    }).catch(error => { if (exited || version !== session.version || controller.signal.aborted) return; busy = false; clearClip(); progress.setPhase('error'); notice.textContent = error.message; display(() => t('even.could_not_transcribe_audio'), error.message); flushPendingDisplay(); })
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
        else display(() => t('even.g2_connected'), () => recorder.source === 'wake' ? idleVoicePrompt() : (operationPreferences.disableHoldRecording ? idleVoicePrompt() : t('even.no_audio_received_hold_to_speak_again')));
      }
      if (state === 'idle' && conversation.hasPendingDisplay) flushPendingDisplay();
      if (state === 'starting') { progress.setPhase('microphone'); audioTraceId = undefined; clearClip(); display(() => t('even.starting_microphone'), () => holdRecording ? t('even.release_to_stop') : t('even.use_the_recording_button_to_stop')); }
      if (state === 'recording') {
        standby?.activity();
        discardButton.disabled = false;
        progress.setPhase('recording');
        if (recorder.source === 'wake') {
          audioTraceId = undefined; clearClip(); discardButton.disabled = false;
          if (keepWakeConversation()) updateRuntime();
          else display(() => t('even.go_ahead'), () => el<HTMLInputElement>('auto-send').checked ? t('even.sends_when_you_finish_speaking') : t('even.transcribes_when_you_finish_speaking'));
        } else display(() => t('even.recording'), () => `${holdRecording ? t('even.release_to_stop') : t('even.use_the_recording_button_to_stop')}\n${t('even.up_to_30_seconds')}`);
      }
    } finally { syncRuntimeEffects(); renderPhoneStatus(); }
  },
  onError: message => { if (exited) return; progress.setPhase('error'); syncRuntimeEffects(); notice.textContent = message; display(() => t('even.action_needed'), message); },
});

const runtimeEffects = new RuntimeEffects({
  state: () => ({exited, tts, ready: glassesReady && relayRestored, paired: !!session.token, subscribed,
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
    el('wake-name-status').textContent = t('even.please_wait_for_the_current_task_to_finish');
    if (!custom) el<HTMLInputElement>('custom-wake-name').checked = wakeNamePreferences.value.custom;
    return;
  }
  const checked = validateWakeName(custom ? el<HTMLInputElement>('wake-name').value : wakeNamePreferences.value.name);
  if (checked.error) {
    el<HTMLInputElement>('wake-name').setAttribute('aria-invalid', 'true');
    el('wake-name-status').textContent = t(checked.error === 'reserved' ? 'even.this_name_cannot_be_used' : 'even.use_1_24_english_letters_for_the_name');
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
    el('wake-name-save-status').textContent = retained ? '' : t('even.settings_could_not_be_saved_here_they_may_reset_when');
  }
  await applying;
  if (exited || version !== wakeNameSaveVersion) return;
  renderWakeState(); updateRuntime();
  el('wake-name-status').textContent = retained ? t('even.name_saved') : '';
}
el<HTMLInputElement>('custom-wake-name').onchange = () => {
  wakeNameEdited = true; wakeNameSaveVersion++;
  const custom = el<HTMLInputElement>('custom-wake-name').checked;
  el('wake-name-status').textContent = '';
  if (!custom) { void saveWakeName(false); return; }
  el('wake-name-fields').hidden = false;
  el('wake-name-status').textContent = t('even.changes_not_saved');
  el<HTMLInputElement>('wake-name').focus();
};
el<HTMLInputElement>('wake-name').oninput = () => {
  wakeNameEdited = true; wakeNameSaveVersion++;
  const input = el<HTMLInputElement>('wake-name');
  const reserved = validateWakeName(input.value).error === 'reserved';
  if (reserved) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  el('wake-name-status').textContent = t(reserved ? 'even.this_name_cannot_be_used' : 'even.changes_not_saved');
};
el<HTMLFormElement>('wake-name-form').onsubmit = event => {
  event.preventDefault(); void saveWakeName(el<HTMLInputElement>('custom-wake-name').checked);
};
renderWakeNameControls();
void recorder.setWakeName(wakeNamePreferences.wakeName);

function recordingHint(): string {
  return operationPreferences.disableHoldRecording ? t('even.hold_to_record_is_disabled') : t('even.hold_to_record_release_to_stop');
}
function renderOperationSettings(): void {
  el<HTMLInputElement>('disable-hold-recording').checked = operationPreferences.disableHoldRecording;
  recordButton.disabled = !glassesReady || recorder.state === 'stopping' || (recorder.state === 'idle' && (!operationPreferencesReady || operationPreferences.disableHoldRecording));
  el('recording-hint').textContent = recordingHint();
}
function refreshIdleVoicePrompt(): void {
  renderOperationSettings();
  if (recorder.state === 'idle' && progress.phase === 'idle' && !conversation.selected && !busy) {
    display(() => session.token ? t('even.g2_connected') : t('even.pair_with_your_mac'), () => session.token ? idleVoicePrompt() : t('even.open_setup_on_your_phone'));
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
    if (!exited) el('hold-save-status').textContent = saved ? '' : t('even.could_not_save_settings');
  });
};

el<HTMLInputElement>('wake-word').checked = operationPreferences.wakeWord;
el<HTMLInputElement>('wake-word').onchange = () => {
  const enabled = el<HTMLInputElement>('wake-word').checked;
  const saved = operationPreferences.save(enabled);
  void recorder.setEnabled(enabled).then(() => { if (!exited) refreshIdleVoicePrompt(); });
  void saved.then(saved => {
    if (!exited) el('operation-save-status').textContent = saved ? '' : t('even.could_not_save_settings');
  });
};

function startRecording(fromHold = false): void {
  if (exited || !operationPreferencesReady || operationPreferences.disableHoldRecording) return;
  if (!glassesReady) { notice.textContent = t('even.check_that_g2_is_connected_and_available_then_reopen_dot'); return; }
  if (busy) { notice.textContent = t('even.please_wait_for_the_current_task_to_finish'); return; }
  if (!session.token || !subscribed || progress.connection !== 'online') { notice.textContent = t('even.check_host_connection', { host: hostName }); return; }
  standby?.activity();
  if (playback.active) playback.cancel();
  holdRecording = fromHold;
  void recorder.start();
}
recordButton.onclick = () => recorder.state === 'idle' ? startRecording() : void recorder.stop();
function showDiscarded(): void {
  discarding = false;
  clearClip(); notice.textContent = t('even.recording_discarded');
  progress.setPhase('idle');
  if (keepWakeConversation()) updateRuntime();
  else if (recorder.source === 'manual' && conversation.selected) showMessage();
  else display(() => t('even.g2_connected'), idleVoicePrompt);
  flushPendingDisplay();
}
discardButton.onclick = () => {
  if (transcriptionController) { transcriptionController.abort(); transcriptionController = undefined; busy = false; }
  clearClip();
  if (recorder.state !== 'idle') {
    discarding = true; notice.textContent = t('even.recording_discarded');
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
  exited = true; pageActive = false; session.stop(); clearPhotos(); pendingText = undefined;
  disconnectRetry.stop(); clearTimeout(disconnectRestoreTimer);
  updates.stop(); if (statusTimer) clearInterval(statusTimer); statusTimer = undefined;
  standby?.stop(); void syncHeadRaise();
  runtimeEffects.stop(); playback.stop(); g2Display.stop(); clearClip(); void recorder.dispose();
}

function retireSupersededRuntime(): void {
  if (exited) return;
  runtimeNative.retire();
  disconnectRetry.stop(); clearTimeout(disconnectRestoreTimer);
  exited = true; pageActive = false; clearPhotos(); pendingText = undefined;
  session.stop(); updates.stop();
  if (statusTimer) clearInterval(statusTimer); statusTimer = undefined;
  if (imuWatchdog) clearTimeout(imuWatchdog); imuWatchdog = undefined;
  transcriptionController?.abort(); transcriptionController = undefined;
  locationSharing.abandon(); standby?.stop(); runtimeEffects.stop();
  g2Display.stop(); playback.stop(false); clearClip(); void recorder.dispose();
  // Keep an unsent text draft selectable; stop controls in the retained page.
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')) control.disabled = true;
  for (const field of document.querySelectorAll<HTMLTextAreaElement>('textarea')) field.readOnly = true;
  el('dot-status').textContent = t('even.connection_moved_to_the_new_view');
  notice.textContent = t('even.this_view_has_stopped_continue_in_the_newly_opened_dot');
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
  void restoreRelay(appBridge);
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
        width: 560, height: 130, isEventCapture: 1, content: t('even.connecting') }),
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
  connection.textContent = t('even.even_hub_connected');
  notice.textContent = '';
  renderOperationSettings();
  // History may finish loading before the Even bridge is ready. Repaint it
  // now: later polls with unchanged history otherwise never update the G2.
  if (conversation.selected) {
    showMessage();
  } else {
    display(() => session.token ? t('even.g2_connected') : t('even.pair_with_your_mac'), () => session.token ? idleVoicePrompt() : t('even.open_setup_on_your_phone'));
  }
  appBridge.onEvenHubEvent(event => {
    exitDiagnostics.observe(event, exited);
    if (exited) return;
    if (event.audioEvent && event.audioEvent.source !== AudioInputSource.Phone) recorder.append(event.audioEvent.audioPcm, event.audioEvent.speakerRole);
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
      void appBridge.shutDownPageContainer(1).then(ok => { exitDiagnostics.record(ok ? 'dialog-opened' : 'dialog-failed'); if (!ok) notice.textContent = t('even.could_not_open_the_system_exit_dialog'); }).catch(() => { exitDiagnostics.record('dialog-failed'); notice.textContent = t('even.could_not_open_the_system_exit_dialog'); });
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
  el('head-raise-status').textContent = t('even.current_angle', { angle });
}
function syncHeadRaise(): Promise<void> {
  imuChain = imuChain.then(async () => {
    const enabled = displayPreferences.value.headRaise && glassesReady && !exited;
    if (!bridge || !runtimeNative.active || enabled === imuActive) return;
    if (imuWatchdog) clearTimeout(imuWatchdog);
    headRaise.reset(); headStatusAt = -Infinity;
    if (enabled) el('head-raise-status').textContent = t('even.waiting_for_head_motion');
    try {
      const ok = await runtimeNative.control(() => bridge!.imuControl(enabled, ImuReportPace.P200));
      if (!runtimeNative.active) return;
      if (!ok) throw new Error('IMU control failed');
      imuActive = enabled;
      if (enabled && !exited && displayPreferences.value.headRaise) {
        imuWatchdog = setTimeout(() => {
          if (headRaise.calibration(performance.now()) === undefined) el('head-raise-status').textContent = t('even.head_motion_is_unavailable_you_can_still_use_your_selected');
        }, 4000);
      }
    } catch {
      el('head-raise-status').textContent = t('even.head_motion_is_unavailable_you_can_still_use_your_selected');
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
  el('head-raise-status').textContent = p.headRaise ? t('even.waiting_for_head_motion') : t('even.head_up_wake_is_off');
  void syncHeadRaise();
}
async function saveDisplayPreferences(p: DisplayPreferences, calibrated = false): Promise<void> {
  const version = ++displaySaveVersion;
  const saved = displayPreferences.save(p);
  applyDisplayPreferences();
  const retained = await saved;
  if (version !== displaySaveVersion || exited) return;
  el('display-settings-status').textContent = retained ? (calibrated ? t('even.forward_gaze_angle_saved') : t('even.display_settings_saved')) : t('even.settings_could_not_be_saved_here_they_may_reset_when');
}
function initializeDisplaySettings(): void {
  applyDisplayPreferences();
  el<HTMLFormElement>('display-settings-form').onsubmit = event => {
    event.preventDefault();
    const idleSeconds = Number(el<HTMLInputElement>('display-idle').value);
    const headAngle = Number(el<HTMLInputElement>('display-head-angle').value);
    if (!Number.isInteger(idleSeconds) || (idleSeconds !== 0 && (idleSeconds < 5 || idleSeconds > 3600))) {
      el('display-settings-status').textContent = t('even.choose_0_or_5_3600_seconds'); return;
    }
    if (!Number.isInteger(headAngle) || headAngle < 5 || headAngle > 60) {
      el('display-settings-status').textContent = t('even.choose_a_head_up_angle_from_5_60'); return;
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
      el('display-settings-status').textContent = t('even.check_the_g2_connection_and_enable_head_up_wake_then'); return;
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
window.addEventListener('online', () => { if (!exited) { if (!disconnectRestoreReady && bridge) void restoreRelay(bridge); else if (disconnectJournal.pending.length) void disconnectRetry.run(); } if (session.token && relayRestored && !exited) updates.start(); });
window.addEventListener('offline', () => { if (exited) return; progress.connection = 'offline'; updateRuntime(); el('dot-status').textContent = `${hostName} · ${t('even.disconnected')}`; });
document.addEventListener('visibilitychange', () => { exitDiagnostics.record(document.hidden ? 'hidden' : 'visible'); if (exited) return; standby?.check(); updateRuntime(); if (!document.hidden) { if (!disconnectRestoreReady && bridge) void restoreRelay(bridge); else if (disconnectJournal.pending.length) void disconnectRetry.run(); if (session.token && relayRestored) updates.start(); } });

void connect().catch(() => {
  if (exited) return;
  const nativeReady = startupStage !== 'bridge';
  connection.textContent = nativeReady ? t('even.could_not_initialize_the_g2_display') : t('even.could_not_initialize_the_even_app_connection');
  notice.textContent = nativeReady ? t('even.check_that_g2_is_connected_and_available_then_reopen_dot') : t('even.the_even_app_connection_is_not_ready_close_and_reopen');
  el('g2-diagnostic').textContent = nativeReady ? `G2_STARTUP_${startupResult ?? 'REQUEST_FAILED'}` : 'EVEN_BRIDGE_UNAVAILABLE';
});
