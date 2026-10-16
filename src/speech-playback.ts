interface Options {
  synthesis: () => SpeechSynthesis | undefined;
  canSpeak: () => boolean;
  changed: () => void;
  failed: () => void;
  now: () => number;
  schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancelTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void;
}

/** Owns playback and the quiet interval before wake input may resume. */
export class SpeechPlayback {
  private options: Options;
  private count = 0;
  private generation = 0;
  private queuedAt = 0;
  private cooldownUntil = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private deferred: SpeechSynthesisUtterance[] = [];
  private stopped = false;

  constructor(options: Options) { this.options = options; }
  get active(): boolean {
    const synthesis = this.options.synthesis();
    return this.count > 0 || !!synthesis?.speaking || !!synthesis?.pending;
  }
  get blocksInput(): boolean { return this.active || this.options.now() < this.cooldownUntil; }

  speak(speech: SpeechSynthesisUtterance): void {
    if (this.stopped) return;
    if (!this.options.canSpeak()) { this.deferred.push(speech); return; }
    const generation = this.generation;
    this.count++; this.queuedAt = this.options.now(); this.options.changed();
    let settled = false;
    const complete = () => {
      if (settled || generation !== this.generation) return;
      settled = true; this.count = Math.max(0, this.count - 1);
      if (!this.count) this.finishCooldown();
    };
    speech.onend = complete;
    speech.onerror = () => { complete(); if (!this.stopped && generation === this.generation) this.options.failed(); };
    try { this.options.synthesis()!.speak(speech); } catch { complete(); }
    this.monitorCompletion();
  }
  flush(): void {
    if (this.stopped || !this.options.canSpeak()) return;
    for (const speech of this.deferred.splice(0)) this.speak(speech);
  }
  cancel(): void {
    if (this.stopped) return;
    this.deferred.length = 0;
    this.generation++; this.count = 0;
    this.options.synthesis()?.cancel(); this.finishCooldown();
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.options.cancelTimer(this.cooldownTimer); this.options.cancelTimer(this.recoveryTimer);
    this.generation++; this.count = 0; this.deferred.length = 0;
    this.options.synthesis()?.cancel();
  }
  private monitorCompletion(): void {
    this.options.cancelTimer(this.recoveryTimer);
    if (this.stopped || !this.count) return;
    this.recoveryTimer = this.options.schedule(() => {
      this.recoveryTimer = undefined;
      if (this.stopped || !this.count) return;
      const synthesis = this.options.synthesis();
      if (this.options.now() - this.queuedAt > 1500 && !synthesis?.speaking && !synthesis?.pending) {
        this.generation++; this.count = 0; this.finishCooldown();
      } else this.monitorCompletion();
    }, 500);
  }
  private finishCooldown(): void {
    this.options.cancelTimer(this.recoveryTimer); this.recoveryTimer = undefined;
    this.cooldownUntil = this.options.now() + 600;
    this.options.cancelTimer(this.cooldownTimer);
    this.cooldownTimer = this.options.schedule(() => this.options.changed(), 650);
    this.options.changed();
  }
}
