export type ClientStage = 'recording_stop' | 'audio_ready' | 'asr_sent' | 'asr_received' | 'utterance_sent' | 'utterance_accepted' | 'reply_received' | 'g2_update_started' | 'g2_update_ack' | 'g2_update_failed';
export interface TimingReport { id: string; events: { stage: ClientStage; at: number; elapsedMs: number }[]; }

// Keep only bounded timing metadata, never conversation or audio content.
export class TimingTracker {
  private traces = new Map<string, { start: number; events: TimingReport['events'] }>();
  mark(id: string, stage: ClientStage): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
    let trace = this.traces.get(id);
    if (!trace) {
      trace = { start: performance.now(), events: [] }; this.traces.set(id, trace);
      if (this.traces.size > 100) this.traces.delete(this.traces.keys().next().value!);
    }
    if (trace.events.some(event => event.stage === stage) || trace.events.length >= 16) return;
    trace.events.push({ stage, at: Date.now(), elapsedMs: Math.round((performance.now() - trace.start) * 1000) / 1000 });
  }
  report(id: string): TimingReport | undefined {
    const trace = this.traces.get(id);
    return trace ? { id, events: structuredClone(trace.events) } : undefined;
  }
}
