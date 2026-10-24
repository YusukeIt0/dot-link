import { Recorder, type RecordingState } from './audio.ts';
import { MicrophoneLease } from './microphone-lease.ts';
import type { LoadWakeDetector, WakeDetector } from './wake-detector.ts';
import type { WakeEvent } from './wake-engine.ts';
import { t } from './i18n.ts';
import { validateWakeName } from './wake-name.ts';

export type WakeState = 'off' | 'loading' | 'listening' | 'paused' | 'error';
export type VoiceSource = 'manual' | 'wake';
interface Options {
  microphone: (open: boolean) => Promise<boolean>;
  loadWake: LoadWakeDetector;
  onClip: (wav: Uint8Array, seconds: number, source: VoiceSource, wakeName: string) => void;
  onState: (state: RecordingState) => void;
  onError: (message: string) => void;
  onWakeState: (state: WakeState) => void;
  now?: () => number;
}

/** Coordinates wake listening and existing manual capture without changing STT/TTS. */
export class VoiceInput {
  source: VoiceSource = 'manual';
  private options: Options;
  private mic: MicrophoneLease;
  private manual: Recorder;
  private detector?: WakeDetector;
  private enabled = false;
  private available = false;
  private sessionActive = false;
  private blocked = false;
  private loading = false;
  private failed = false;
  private disposed = false;
  private detectorActive = false;
  private capture: 'recording' | 'stopping' | undefined;
  private closeFailed = false;
  private loadVersion = 0;
  private listenVersion = 0;
  private wakeState: WakeState = 'off';
  private watchdog?: ReturnType<typeof setInterval>;
  private lastFrame = 0;
  private now: () => number;
  private wakeName = 'dot';
  private detectorName = 'dot';
  private captureName = 'dot';
  private detectorEpoch = 0;

  constructor(options: Options) {
    this.options = options; this.now = options.now ?? (() => performance.now());
    this.mic = new MicrophoneLease(options.microphone);
    this.manual = new Recorder(open => this.mic.setCapture(open),
      (wav, seconds) => options.onClip(wav, seconds, 'manual', this.wakeName),
      state => {
        if (state === 'idle') void this.mic.setCapture(false);
        options.onState(state); this.sync();
      }, options.onError);
  }
  get state(): RecordingState { return this.closeFailed ? 'stop-error' : this.capture ?? this.manual.state; }

  async setWakeName(name: string): Promise<void> {
    const checked = validateWakeName(name);
    if (checked.error) throw new Error('Invalid wake name');
    if (checked.name === this.wakeName) return;
    this.wakeName = checked.name;
    // A current utterance keeps its detector and original cleanup name.
    // sync() applies the pending name once both capture paths are idle.
    if (this.enabled && this.state === 'idle') await this.setEnabled(true);
  }

  setContext(available: boolean, blocked: boolean, sessionActive = available): void {
    this.available = available; this.blocked = blocked; this.sessionActive = sessionActive;
    // A poll failure prevents new wake input, but does not erase an utterance.
    // Only explicit unpair/exit invalidates the active recording session.
    if (!sessionActive && this.manual.state !== 'idle') void this.manual.stop(true);
    this.sync();
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return;
    this.enabled = enabled; this.failed = false;
    if (enabled && (this.capture || this.manual.state !== 'idle')) { this.sync(); return; }
    const version = ++this.loadVersion;
    if (!enabled) {
      // Turning off automatic activation must not discard a held utterance.
      if (this.capture && this.source === 'manual') { this.sync(); return; }
      this.loading = false; this.cancelCapture();
      this.detector?.dispose(); this.detector = undefined; this.detectorEpoch++;
      this.detectorActive = false;
      this.stopWatchdog();
      await this.closeListening(); this.updateWakeState();
      return;
    }
    if (this.detector && this.detectorName !== this.wakeName) {
      this.detectorActive = false; this.listenVersion++;
      this.stopWatchdog(); this.detector.dispose(); this.detector = undefined; this.detectorEpoch++;
      this.loading = true; this.updateWakeState();
      await this.closeListening();
      if (version !== this.loadVersion || this.disposed || !this.enabled) return;
    }
    if (!this.detector) {
      this.loading = true; this.updateWakeState();
      const name = this.wakeName, epoch = ++this.detectorEpoch;
      try {
        const detector = await this.options.loadWake(event => {
          if (epoch === this.detectorEpoch) this.handle(event);
        }, () => { if (epoch === this.detectorEpoch) this.fail(); }, name);
        if (version !== this.loadVersion || this.disposed || !this.enabled) { detector.dispose(); return; }
        this.detector = detector; this.detectorName = name;
      } catch { if (version === this.loadVersion && !this.disposed) this.failed = true; }
      if (version !== this.loadVersion) return;
      this.loading = false;
    }
    this.sync();
  }
  start(): Promise<void> {
    if (this.closeFailed) { this.reportCloseFailure(); return Promise.resolve(); }
    if (this.disposed || !this.available) return Promise.resolve();
    if (this.capture === 'recording') {
      this.source = 'manual'; this.detector?.hold(); this.options.onState('recording');
      return Promise.resolve();
    }
    if (this.state !== 'idle') return Promise.resolve();
    this.source = 'manual';
    // Reserve before Recorder emits `starting`, which pauses the wake listener.
    // Both users then share one uninterrupted physical microphone session.
    void this.mic.setCapture(true);
    return this.manual.start();
  }
  async stop(discard = false): Promise<void> {
    if (this.closeFailed) {
      await this.closeListening();
      return;
    }
    if (this.capture) {
      if (this.capture === 'stopping') return;
      this.capture = 'stopping'; this.options.onState('stopping');
      this.detector?.finish(discard);
      return;
    }
    await this.manual.stop(discard);
  }
  append(pcm: Uint8Array): void {
    if (this.disposed) return;
    this.manual.append(pcm);
    if (!this.detectorActive) return;
    if (this.now() - this.lastFrame > 5000) { this.fail(); return; }
    this.lastFrame = this.now();
    this.detector?.append(pcm);
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.enabled = false; this.loadVersion++;
    this.cancelCapture(); this.detector?.dispose(); this.detector = undefined; this.detectorEpoch++;
    this.detectorActive = false; this.stopWatchdog();
    await this.closeListening(); await this.manual.stop(true);
  }
  private handle(event: WakeEvent): void {
    if (!this.detectorActive || this.disposed) return;
    if (event.type === 'wake') {
      if (!this.available || this.blocked || this.manual.state !== 'idle' || this.capture) return;
      this.source = 'wake'; this.captureName = this.detectorName; this.capture = 'recording'; this.options.onState('recording');
      return;
    }
    if (!this.capture) return;
    const source = this.source;
    this.capture = 'stopping'; this.options.onState('stopping');
    if (event.wav) this.options.onClip(event.wav, event.seconds, source, this.captureName);
    this.capture = undefined; this.detectorActive = false;
    if (!this.enabled) { this.detector?.dispose(); this.detector = undefined; }
    this.options.onState('idle'); this.sync();
    if (!this.detectorActive) { this.stopWatchdog(); void this.closeListening(); }
  }
  private cancelCapture(): void {
    const wasCapturing = !!this.capture;
    this.capture = undefined;
    this.detector?.cancel();
    if (wasCapturing) this.options.onState('idle');
  }
  private sync(): void {
    if (this.enabled && !this.loading && !this.failed && !this.disposed && !this.closeFailed &&
        !this.capture && this.manual.state === 'idle' && (!this.detector || this.detectorName !== this.wakeName)) {
      void this.setEnabled(true); return;
    }
    const wanted = (this.enabled || (!!this.capture && this.source === 'manual')) && !this.loading && !this.failed && !this.closeFailed && !this.disposed &&
      this.sessionActive && (this.available || !!this.capture) && !this.blocked && this.manual.state === 'idle' && !!this.detector;
    if (wanted !== this.detectorActive) {
      this.detectorActive = wanted;
      const version = ++this.listenVersion;
      if (wanted) {
        this.lastFrame = this.now();
        this.detector!.listen();
        void this.mic.setListening(true).then(ok => {
          if (!ok && version === this.listenVersion && this.detectorActive) this.fail();
        });
        this.watchdog ??= setInterval(() => {
          if (this.detectorActive && this.now() - this.lastFrame > 5000) this.fail();
        }, 1000);
      } else {
        this.stopWatchdog(); this.cancelCapture();
        void this.closeListening();
      }
    }
    this.updateWakeState();
  }
  private fail(): void {
    if (this.disposed) return;
    this.failed = true;
    this.sync();
    this.detector?.dispose(); this.detector = undefined; this.detectorEpoch++;
  }
  private async closeListening(): Promise<void> {
    const ok = await this.mic.setListening(false);
    const wasFailed = this.closeFailed;
    this.closeFailed = !ok;
    if (!ok) { this.failed = true; this.options.onState('stop-error'); this.reportCloseFailure(); }
    else if (wasFailed) this.options.onState(this.state);
    this.updateWakeState();
  }
  private reportCloseFailure(): void {
    this.options.onError(t('even.could_not_confirm_microphone_stop_stop_it_in_the_even'));
  }
  private stopWatchdog(): void { clearInterval(this.watchdog); this.watchdog = undefined; }
  private updateWakeState(): void {
    const state: WakeState = this.failed || this.closeFailed ? 'error' : !this.enabled ? 'off' :
      this.loading ? 'loading' : this.detectorActive ? 'listening' : 'paused';
    if (state !== this.wakeState) { this.wakeState = state; this.options.onWakeState(state); }
  }
}
