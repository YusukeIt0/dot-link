import { t, seconds } from './i18n.ts';
export type InteractionPhase = 'idle' | 'microphone' | 'recording' | 'recognizing' | 'sending' | 'waiting' | 'review' | 'error';
export type ConnectionState = 'connecting' | 'online' | 'offline' | 'unpaired';
interface Measurement { started: number; paused?: number; pausedMs: number; completedMs?: number; }

/** Observed elapsed time, not an ETA. Notification arrivals cannot finish a voice request. */
export class InteractionStatus {
  phase: InteractionPhase = 'idle';
  connection: ConnectionState = 'connecting';
  dotConnected = false;
  private activeId?: string;
  private measurements = new Map<string, Measurement>();
  private clock: () => number;
  constructor(clock: () => number = () => performance.now()) { this.clock = clock; }
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
  waiting(id: string): void {
    if (this.activeId === id && this.measurements.get(id)?.completedMs === undefined) this.phase = 'waiting';
  }
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
  caption(fallback: string, visibleId?: string): string {
    if (this.phase === 'microphone') return t('マイク準備中');
    if (this.phase === 'recording') return t('録音中');
    if (this.connection === 'unpaired') return t('接続設定が必要');
    if (this.connection === 'offline') return t('切断 · 再接続中');
    if (this.connection === 'connecting') return t('接続を確認中');
    if (!this.dotConnected && ['idle', 'waiting'].includes(this.phase)) return t('Dot未接続');
    const label = { recognizing: t('認識中'), sending: t('送信中'), waiting: t('Dotの返信待ち') }[this.phase as 'recognizing' | 'sending' | 'waiting'];
    const measurement = this.activeId ? this.measurements.get(this.activeId) : undefined;
    if (label && measurement) return `${label} · ${seconds(Math.floor(Math.max(0, this.clock() - measurement.started - measurement.pausedMs) / 1000))}`;
    const complete = visibleId ? this.measurements.get(visibleId)?.completedMs : undefined;
    return complete === undefined ? fallback : `${fallback} · ${seconds((complete / 1000).toFixed(1))}`;
  }
}
