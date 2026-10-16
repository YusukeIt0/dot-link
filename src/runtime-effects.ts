export interface RuntimeEffectState {
  exited: boolean;
  tts: boolean;
  ready: boolean;
  paired: boolean;
  subscribed: boolean;
  online: boolean;
  busy: boolean;
  recording: boolean;
  draft: boolean;
  playbackBlocks: boolean;
  phaseProtect: boolean;
  waitingMs: number;
}
interface Options {
  state: () => RuntimeEffectState;
  flushSpeech: () => void;
  voiceContext: (available: boolean, blocked: boolean, sessionActive: boolean) => void;
  protectStandby: (blocked: boolean) => void;
  schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Runs policy effects on state changes; rendering never invokes this owner. */
export class RuntimeEffects {
  private options: Options;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private pending = false;
  private stopped = false;
  constructor(options: Options) { this.options = options; }

  sync(): void {
    if (this.stopped) return;
    if (this.running) { this.pending = true; return; }
    this.running = true;
    try {
      do {
        this.pending = false;
        let state = this.options.state();
        if (state.exited) { this.stop(); return; }
        if (state.tts) this.options.flushSpeech();
        // Speech may synchronously change input eligibility or trigger callbacks.
        state = this.options.state();
        if (this.stopped || state.exited) { this.stop(); return; }
        const sessionActive = state.ready && state.paired;
        this.options.voiceContext(sessionActive && state.subscribed && state.online,
          state.busy || state.playbackBlocks || (!state.recording && state.draft), sessionActive);
        // Voice callbacks may synchronously change recording/interaction state.
        state = this.options.state();
        if (this.stopped || state.exited) { this.stop(); return; }
        this.options.protectStandby(state.busy || state.recording || state.phaseProtect || state.waitingMs > 0);
        if (this.stopped) return;
        this.clearTimer();
        if (state.waitingMs > 0) this.timer = this.options.schedule(() => {
          this.timer = undefined; this.sync();
        }, state.waitingMs);
      } while (this.pending && !this.stopped);
    } finally { this.running = false; }
  }

  stop(): void { this.stopped = true; this.pending = false; this.clearTimer(); }
  private clearTimer(): void {
    if (this.timer !== undefined) this.options.cancel(this.timer);
    this.timer = undefined;
  }
}
