import { t, seconds } from './i18n.ts';
export type InteractionPhase = 'idle' | 'microphone' | 'recording' | 'recognizing' | 'sending' | 'waiting' | 'review' | 'error';
export type ConnectionState = 'connecting' | 'online' | 'offline' | 'unpaired';
interface Measurement { started: number; paused?: number; pausedMs: number; waitingStarted?: number; completedMs?: number; }

/** Observed elapsed time, not an ETA. Notification arrivals cannot finish a voice request. */
export class InteractionStatus {
  phase: InteractionPhase = 'idle';
  connection: ConnectionState = 'connecting';
  dotConnected = false;
  private activeId?: string;
  private measurements = new Map<string, Measurement>();
  private clock: () => number;
  constructor(clock: () => number = () => performance.now()) { this.clock = clock; }
  reset(): void { this.phase = 'idle'; this.activeId = undefined; this.measurements.clear(); this.dotConnected = false; }
  setPhase(phase: InteractionPhase): void {
    this.phase = phase;
    if (phase === 'microphone' || phase === 'recording' || phase === 'idle') this.activeId = undefined;
  }
  begin(id: string, phase: 'recognizing' | 'sending'): void {
    let measurement = this.measurements.get(id);
    if (!measurement) {
      measurement = { started: this.clock(), pausedMs: 0 }; this.measurements.set(id, measurement);
      if (this.measurements.size > 100) this.measurements.delete(this.measurements.keys().next().value!);
    }
    if (measurement.completedMs !== undefined) { this.activeId = undefined; this.phase = 'idle'; return; }
    if (measurement.paused !== undefined) {
      measurement.pausedMs += this.clock() - measurement.paused; measurement.paused = undefined;
    }
    this.activeId = id; this.phase = phase;
  }
  review(): void {
    const measurement = this.activeId ? this.measurements.get(this.activeId) : undefined;
    if (measurement) measurement.paused = this.clock();
    this.phase = 'review';
  }
  waiting(id: string, createdAt?: string, wallNow = Date.now()): void {
    const measurement = this.measurements.get(id);
    if (this.activeId === id && measurement && measurement.completedMs === undefined) {
      const created = Date.parse(createdAt ?? '');
      measurement.waitingStarted ??= this.clock() - (Number.isFinite(created) ? Math.max(0, wallNow - created) : 0);
      this.phase = 'waiting';
    }
  }
  restoreWaiting(id: string, createdAt?: string, wallNow = Date.now()): void {
    const created = Date.parse(createdAt ?? '');
    if (!Number.isFinite(created)) return;
    const started = this.clock() - Math.max(0, wallNow - created);
    if (!this.measurements.has(id)) this.measurements.set(id, { started, waitingStarted: started, pausedMs: 0 });
    this.activeId = id; this.phase = 'waiting';
  }
  get waitingProtectionMs(): number {
    if (this.phase !== 'waiting' || !this.activeId) return 0;
    const started = this.measurements.get(this.activeId)?.waitingStarted;
    return started === undefined ? 0 : Math.max(0, 60_000 - (this.clock() - started));
  }
  get protectWaiting(): boolean { return this.waitingProtectionMs > 0; }
  complete(id: string): void {
    const measurement = this.measurements.get(id);
    if (!measurement || measurement.completedMs !== undefined) return;
    measurement.completedMs = Math.max(0, (measurement.paused ?? this.clock()) - measurement.started - measurement.pausedMs);
    if (id === this.activeId) { this.phase = 'idle'; this.activeId = undefined; }
  }
  get ticking(): boolean {
    return this.connection === 'online' && ['recognizing', 'sending', 'waiting'].includes(this.phase) && this.activeId !== undefined;
  }
  get state(): string {
    return this.connection === 'online' ? this.phase : this.connection;
  }
  caption(fallback: string, visibleId?: string, assistantName = 'Dot'): string {
    if (this.phase === 'microphone') return t('even.starting_microphone');
    if (this.phase === 'recording') return t('even.recording');
    if (this.connection === 'unpaired') return t('even.pair_with_your_mac');
    if (this.connection === 'offline') return t('even.disconnected_reconnecting');
    if (this.connection === 'connecting') return t('even.connecting');
    if (!this.dotConnected && ['idle', 'waiting'].includes(this.phase)) return t('even.dot_disconnected');
    const label = { recognizing: t('even.transcribing'), sending: t('even.sending'), waiting: t('even.waiting_for_name', { name: assistantName }) }[this.phase as 'recognizing' | 'sending' | 'waiting'];
    const measurement = this.activeId ? this.measurements.get(this.activeId) : undefined;
    if (label && measurement && (this.phase !== 'waiting' || !visibleId || visibleId === this.activeId)) {
      const elapsed = seconds(Math.floor(Math.max(0, this.clock() - measurement.started - measurement.pausedMs) / 1000));
      return this.phase === 'waiting' ? `${label} (${elapsed})` : `${label} · ${elapsed}`;
    }
    const complete = visibleId ? this.measurements.get(visibleId)?.completedMs : undefined;
    return complete === undefined ? fallback : `${fallback} ${seconds((complete / 1000).toFixed(1))}`;
  }
}
