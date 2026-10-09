import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { z } from 'zod';

// Timing metadata only: never accept text, audio, URLs, or credentials here.
export const traceId = z.string().uuid();
const clientStage = z.enum(['recording_stop', 'audio_ready', 'asr_sent', 'asr_received', 'utterance_sent', 'utterance_accepted', 'reply_received', 'g2_update_started', 'g2_update_ack', 'g2_update_failed']);
export const clientTiming = z.object({
  id: traceId,
  events: z.array(z.object({ stage: clientStage, at: z.number().finite().nonnegative(), elapsedMs: z.number().finite().min(0).max(3_600_000) }).strict()).min(1).max(16),
}).strict();
export type ClientTiming = z.infer<typeof clientTiming>;
export type TimingStage = 'utterance_created' | 'webhook_sent' | 'webhook_accepted' | 'webhook_failed' | 'dot_pending_read' | 'dot_reply_received' | 'reply_stored' | 'asr_received' | 'asr_complete' | 'asr_failed';
export type TimingRow = { id: string; stage: string; at: number; elapsedMs?: number; clientAt?: number };

export class LatencyLog {
  private path?: string;
  constructor(path?: string) { this.path = path; }
  private write(row: TimingRow) {
    if (!this.path) return;
    // Diagnostics must never break delivery. Two bounded local files, mode 600.
    try {
      if (existsSync(this.path) && statSync(this.path).size > 1_000_000) renameSync(this.path, `${this.path}.previous`);
      appendFileSync(this.path, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch { /* A failed timing write is not a failed message. */ }
  }
  mark(id: string, stage: TimingStage) { this.write({ id: traceId.parse(id), stage, at: Date.now() }); }
  client(input: unknown) {
    const value = clientTiming.parse(input);
    const receivedAt = Date.now();
    for (const event of value.events) this.write({ id: value.id, stage: `client_${event.stage}`, at: receivedAt, clientAt: event.at, elapsedMs: event.elapsedMs });
  }
}
