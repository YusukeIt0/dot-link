import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Bridge } from './bridge.ts';
import type { LocationContext } from './location.ts';
import { ToolRejection } from './tool-response.ts';

const recordSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), id: z.string().uuid(), createdAt: z.string().datetime(),
  attempts: z.number().int().min(0).max(3), nextAttempt: z.number(),
  delivery: z.enum(['pending', 'accepted', 'failed', 'complete']),
});
type Record = z.infer<typeof recordSchema>;

/** Translate the existing sharing control into one bounded owner request to the
 * already-connected Dot. Only ChatGPT can create the real location subscription.
 * No coordinates, conversation messages, callback credentials or AI decisions are
 * stored here. This does not pretend a webhook receipt is a subscription. */
export class SharingActivation {
  private record?: Record;
  private closed = false;
  private scheduled = false;
  private sending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly removers: (() => void)[];
  private readonly path: string;
  private readonly bridge: Bridge;
  private readonly locations: LocationContext;
  private readonly now: () => number;
  constructor(path: string, bridge: Bridge, locations: LocationContext, now = Date.now) {
    this.path = path; this.bridge = bridge; this.locations = locations; this.now = now;
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    try { this.record = recordSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Sharing activation could not be loaded');
    }
    this.removers = [bridge.changes.subscribe(() => this.schedule()), locations.changes.subscribe(() => this.schedule())];
    this.schedule();
  }
  private source(includeSubscribed = false) {
    const intent = this.locations.sharingIntent(), destination = this.bridge.inputDestination();
    if (this.closed || !intent || intent.activationStopped || (!includeSubscribed && intent.subscribed) || !destination) return undefined;
    return {key: createHash('sha256').update(JSON.stringify(['owner-input-v2', intent.id, destination.id])).digest('hex'),
      destinationId: destination.id, subscribed: intent.subscribed, expiresAt: Math.min(intent.expiresAt, destination.expiresAt)};
  }
  pending() {
    const source = this.source(), record = this.record;
    if (!source || !record || source.key !== record.key) return [];
    return [{request_id: record.id, utterance_id: record.id, source: 'owner_sharing_control' as const, created_at: record.createdAt,
      text: '[Dot Link app action — not spoken text] The owner enabled location sharing, including autonomous use of permitted context. Requested action: establish location.updated reception for this same personal-g2 connection using the normal event subscription mechanism. Preserve conversation reception and existing information-sharing choices. This app action already expresses the owner’s choice; no second setup or confirmation is requested. Read get_location_context and follow its activity_guidance to choose relevant permitted context within the activity. Decide whether meaningful context warrants an announcement; silence is valid. Do not send a setup confirmation to G2. This control item is temporary and is not conversation history. Re-read pending input before acting; an absent item is no longer actionable.',
      request: 'Receive meaningful location and permitted context changes for the sharing enabled in Dot Link. Decide whether useful information warrants an announcement; silence is valid.',
      event: 'location.updated', arguments: {session_id: 'personal-g2'},
      sharing_enabled: true, subscription_active: false}];
  }
  acknowledge(name: 'reply_to_g2' | 'send_message_to_g2', input: unknown) {
    const fields = {utterance_id: z.string().uuid(), text: z.string().trim().min(1).max(8000)};
    const schema = name === 'reply_to_g2' ? z.object(fields).strict()
      : z.object({...fields, message_id: z.string().uuid()}).strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success || parsed.data.utterance_id !== this.record?.id) return undefined;
    const source = this.source(true);
    if (!source || source.key !== this.record.key) throw new ToolRejection('sharing_control_revoked',
      'This app action is no longer active. Do not send its confirmation or retry it as a new message.');
    if (!source.subscribed) throw new ToolRejection('sharing_activation_pending',
      'Context reception is not established. Read current pending input and establish the requested event subscription; do not send a setup confirmation to G2.');
    // Older input handlers always reply to each input ID. A control acknowledgement
    // must neither become a G2 message nor claim that reply text was delivered.
    return {request_id: this.record.id, source: 'owner_sharing_control', subscription_active: true, delivered_to_g2: false};
  }
  private save(record: Record) {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(record), {mode: 0o600});
    renameSync(`${this.path}.tmp`, this.path); this.record = record;
  }
  private schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.sync().catch(() => {
        // A local failure must not break ordinary conversation or trigger a hot loop.
        if (!this.closed) this.arm(this.now() + 30_000);
      });
    });
  }
  private arm(at: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.schedule(), Math.max(1, at - this.now())); this.timer.unref();
  }
  async sync() {
    if (this.closed || this.sending) return;
    clearTimeout(this.timer); this.timer = undefined;
    const source = this.source(true);
    if (!source) return;
    if (source.subscribed) {
      if (this.record?.key === source.key && this.record.delivery !== 'complete') this.save({...this.record, delivery: 'complete'});
      return;
    }
    if (this.record?.key !== source.key || this.record.delivery === 'complete') this.save({key: source.key, id: randomUUID(),
      createdAt: new Date(this.now()).toISOString(), attempts: 0, nextAttempt: this.now(), delivery: 'pending'});
    const record = this.record!;
    if (record.delivery === 'accepted' || record.delivery === 'failed') return;
    if (record.attempts >= 3) {this.save({...record, delivery: 'failed'}); return;}
    if (record.nextAttempt > this.now()) {this.arm(Math.min(record.nextAttempt, source.expiresAt)); return;}
    // Persist the attempt before sending. A crash cannot reset an unlimited retry budget.
    const attempt = {...record, attempts: record.attempts + 1, nextAttempt: this.now() + 5_000};
    this.save(attempt); this.sending = true;
    let status: number | undefined;
    try {
      status = await this.bridge.sendSharingControl(attempt, source.destinationId,
        () => this.source()?.key === source.key);
    } catch { status = 0; }
    finally { this.sending = false; }
    // Revocation, a replacement owner/session, or an already-established subscription wins.
    if (this.closed || this.source()?.key !== source.key) {this.schedule(); return;}
    const transient = status === 0 || status === 429 || (status !== undefined && status >= 500);
    const accepted = status !== undefined && status >= 200 && status < 300;
    this.save({...attempt, delivery: accepted ? 'accepted' : transient && attempt.attempts < 3 ? 'pending' : 'failed',
      nextAttempt: this.now() + 5_000 * 2 ** (attempt.attempts - 1)});
    if (this.record!.delivery === 'pending') this.arm(Math.min(this.record!.nextAttempt, source.expiresAt));
  }
  close() {
    this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    for (const remove of this.removers) remove();
  }
}
