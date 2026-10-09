export interface DisplayPreferences {
  idleSeconds: number;
  wakeTap: 'single' | 'double';
  headRaise: boolean;
  headAngle: number;
  neutralPitch: number;
}

export const DEFAULT_DISPLAY_PREFERENCES: Readonly<DisplayPreferences> = Object.freeze({
  idleSeconds: 30, wakeTap: 'double', headRaise: true, headAngle: 20, neutralPitch: 0,
});
export const DISPLAY_PREFERENCES_KEY = 'dot-display-v1';

export function parseDisplayPreferences(raw: string | null): DisplayPreferences | undefined {
  try {
    const p = JSON.parse(raw ?? 'null');
    if (!p || !Number.isInteger(p.idleSeconds) || (p.idleSeconds !== 0 && (p.idleSeconds < 5 || p.idleSeconds > 3600)) ||
      !['single', 'double'].includes(p.wakeTap) || typeof p.headRaise !== 'boolean' ||
      !Number.isInteger(p.headAngle) || p.headAngle < 5 || p.headAngle > 60 ||
      !Number.isFinite(p.neutralPitch) || Math.abs(p.neutralPitch) > 180) return;
    return { idleSeconds: p.idleSeconds, wakeTap: p.wakeTap, headRaise: p.headRaise, headAngle: p.headAngle, neutralPitch: p.neutralPitch };
  } catch { return; }
}

interface Clock {
  now(): number;
  schedule(callback: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}
const realClock: Clock = {
  now: () => performance.now(), schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** App-level blanking only. Never owns the network receiver or app lifetime. */
export class DisplayStandby {
  hidden = false;
  private enabled = false;
  private blocked = false;
  private timer?: unknown;
  private lastActivity = 0;
  private consumeTapsUntil = 0;
  private preferences: DisplayPreferences;
  private changed: (hidden: boolean) => void;
  private clock: Clock;
  constructor(preferences: DisplayPreferences, changed: (hidden: boolean) => void, clock: Clock = realClock) {
    this.preferences = preferences; this.changed = changed; this.clock = clock;
  }

  start(): void { this.enabled = true; this.activity(); }
  stop(): void { this.enabled = false; this.clearTimer(); }
  configure(preferences: DisplayPreferences): void { this.preferences = preferences; this.activity(); }
  activity(): void {
    if (!this.enabled) return;
    this.lastActivity = this.clock.now();
    if (this.hidden) { this.hidden = false; this.changed(false); }
    this.arm();
  }
  protect(blocked: boolean): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    // Once a task finishes, give its result a full reading window.
    this.activity();
  }
  /** True means consume this gesture; it must not also navigate or exit. */
  tap(kind: 'single' | 'double'): boolean {
    if (this.clock.now() < this.consumeTapsUntil) return true;
    if (!this.hidden) { this.activity(); return false; }
    if (kind === this.preferences.wakeTap) {
      this.activity();
      // Some hosts emit a single, then a double, or duplicate the wake event.
      this.consumeTapsUntil = this.clock.now() + 650;
    }
    return true;
  }
  check(): void {
    this.clearTimer();
    if (!this.enabled || this.blocked || this.hidden || this.preferences.idleSeconds === 0) return;
    const remaining = this.lastActivity + this.preferences.idleSeconds * 1000 - this.clock.now();
    if (remaining > 0) { this.timer = this.clock.schedule(() => this.check(), remaining); return; }
    this.hidden = true;
    this.changed(true);
  }
  private arm(): void {
    this.clearTimer();
    if (this.enabled && !this.blocked && !this.hidden && this.preferences.idleSeconds > 0) {
      this.timer = this.clock.schedule(() => this.check(), this.preferences.idleSeconds * 1000);
    }
  }
  private clearTimer(): void { if (this.timer !== undefined) this.clock.cancel(this.timer); this.timer = undefined; }
}

/** Rising edge + dwell prevents noise and a held-up head from repeatedly waking. */
export class HeadRaiseDetector {
  private armed = false;
  private highSince?: number;
  private lastAt = -Infinity;
  private pitch?: number;
  private preferences: DisplayPreferences;
  constructor(preferences: DisplayPreferences) { this.preferences = preferences; }
  configure(preferences: DisplayPreferences): void { this.preferences = preferences; this.reset(); }
  reset(): void { this.armed = false; this.highSince = undefined; this.lastAt = -Infinity; this.pitch = undefined; }
  get angle(): number | undefined { return this.pitch === undefined ? undefined : this.relative(this.pitch); }
  calibration(now: number): number | undefined { return now - this.lastAt <= 2000 ? this.pitch : undefined; }
  sample(value: { x?: number; y?: number; z?: number }, now: number): boolean {
    const { x, y, z } = value;
    if (!this.preferences.headRaise || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || Math.hypot(x!, y!, z!) < 0.0001) return false;
    if (now - this.lastAt > 2000) { this.armed = false; this.highSince = undefined; }
    this.lastAt = now;
    // G2 gravity convention: forward +z, looking up +x. Zero is user-calibrated.
    this.pitch = Math.atan2(x!, z!) * 180 / Math.PI;
    const angle = this.relative(this.pitch);
    if (angle <= this.preferences.headAngle - 5) { this.armed = true; this.highSince = undefined; return false; }
    if (angle < this.preferences.headAngle || !this.armed) { this.highSince = undefined; return false; }
    this.highSince ??= now;
    if (now - this.highSince < 200) return false;
    this.armed = false; this.highSince = undefined;
    return true;
  }
  private relative(pitch: number): number { return ((pitch - this.preferences.neutralPitch + 540) % 360) - 180; }
}
