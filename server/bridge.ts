import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ChangeSignal } from './changes.ts';
import { callbackUrl, signingSecret, WebhookSender } from './webhook.ts';
import { LatencyLog } from './latency.ts';

const SESSION = 'personal-g2';
const argsSchema = z.object({ session_id: z.literal(SESSION) }).strict();
const deliverySchema = z.object({ mode: z.literal('webhook'), url: z.string().max(2048), secret: z.string().max(100) }).strict();
const subscribeSchema = z.object({
  name: z.literal('utterance.created'), arguments: argsSchema, delivery: deliverySchema,
  cursor: z.null().optional(), ttlMs: z.number().int().positive().max(86_400_000).nullable().optional(),
});
const replySchema = z.object({ utterance_id: z.string().uuid(), text: z.string().trim().min(1).max(8000) }).strict();
const subscriptionSchema = z.object({ id: z.string(), url: z.string(), secret: z.string(), expiresAt: z.number() });
const utteranceSchema = z.object({
  id: z.string().uuid(), text: z.string(), createdAt: z.string(),
  status: z.enum(['pending', 'accepted', 'failed', 'replied']),
  reply: z.string().optional(), repliedAt: z.string().optional(),
});
const outboundInput = z.object({
  message_id: z.string().uuid(), text: z.string().trim().min(1).max(8000),
}).strict();
const outboundRecord = outboundInput.extend({ createdAt: z.string() });
const stateSchema = z.object({ version: z.literal(1), subscription: subscriptionSchema.optional(), messages: z.array(utteranceSchema).max(100), outbound: z.array(outboundRecord).max(1000).default([]) });
type State = z.infer<typeof stateSchema>;
type Subscription = z.infer<typeof subscriptionSchema>;

export const eventDefinition = {
  name: 'utterance.created', description: 'A new utterance from the owner of this personal Even G2 bridge.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { session_id: { type: 'string', const: SESSION } }, required: ['session_id'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: {
    session_id: { type: 'string', const: SESSION }, utterance_id: { type: 'string' }, text: { type: 'string' },
  }, required: ['session_id', 'utterance_id', 'text'], additionalProperties: false },
};
export const replyTool = {
  name: 'reply_to_g2', description: 'Deliver a reply to an existing utterance on the owner’s paired Even G2. Use its utterance_id; identical retries do not duplicate replies.',
  inputSchema: { type: 'object', properties: { utterance_id: { type: 'string', format: 'uuid' }, text: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['utterance_id', 'text'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const sendMessageTool = {
  name: 'send_message_to_g2',
  description: 'Send a NEW proactive message or follow-up to the owner’s G2 at any time, without an utterance ID or event subscription. Use this whenever you decide to reach out or send a second message after an earlier reply. Generate a fresh UUID message_id for each distinct message; reuse that same ID and identical text on retry. This sends now, not at a scheduled time. Receipt confirms storage for G2, not physical display. Do not overwrite an earlier reply_to_g2 response.',
  inputSchema: { type: 'object', properties: { message_id: { type: 'string', format: 'uuid' }, text: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['message_id', 'text'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const statusTool = {
  name: 'get_status', description: 'Read connection status of this personal Even G2 bridge before subscribing. Returns subscription status, message count, and session ID only; no conversation text.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const pendingTool = {
  name: 'get_pending_utterances', description: 'Read up to 10 unanswered utterances from the owner of this personal Even G2 bridge, oldest first. Use after an utterance.created notification even when the notification body is unavailable. Reply using each returned utterance_id. Already answered utterances are excluded.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export class Bridge {
  readonly changes = new ChangeSignal();
  private state: State;
  private path: string;
  private sender: WebhookSender;
  private hosts: string[];
  readonly latency: LatencyLog;
  private operation: Promise<unknown> = Promise.resolve();
  constructor(path: string, sender: WebhookSender, hosts: string[], latency = new LatencyLog()) {
    this.latency = latency;
    this.path = path; this.sender = sender; this.hosts = hosts;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { this.state = stateSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Bridge state could not be loaded');
      this.state = { version: 1, messages: [], outbound: [] }; this.save();
    }
  }
  private save(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.changes.emit();
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action, action);
    this.operation = next.catch(() => {}); return next;
  }
  private active(): Subscription | undefined {
    const sub = this.state.subscription;
    return sub && sub.expiresAt > Date.now() ? sub : undefined;
  }
  status() { return { subscribed: !!this.active(), messageCount: this.state.messages.length, sessionId: SESSION }; }
  history() { return structuredClone(this.state.messages); }
  pending() {
    for (const item of this.state.messages.filter(item => item.status !== 'replied').slice(0, 10)) this.latency.mark(item.id, 'dot_pending_read');
    return { session_id: SESSION, utterances: this.state.messages.filter(item => item.status !== 'replied').slice(0, 10)
      .map(item => ({ utterance_id: item.id, text: item.text, created_at: item.createdAt })) };
  }

  outboundHistory() {
    return this.state.outbound.map(m => ({
      id: `dot:${m.message_id}`, kind: 'proactive' as const, text: '', reply: m.text,
      status: 'replied', createdAt: m.createdAt,
    }));
  }
  sendMessage(input: unknown) {
    return this.serial(async () => {
      const p = outboundInput.parse(input);
      const existing = this.state.outbound.find(m => m.message_id === p.message_id);
      if (existing && existing.text !== p.text) throw new Error('Message ID conflicts');
      if (!existing) {
        // Retain IDs so a retry cannot become a duplicate after history eviction.
        if (this.state.outbound.length >= 1000) throw new Error('Outbound storage is full');
        this.state.outbound.push({ ...p, createdAt: new Date().toISOString() });
        this.save();
      }
      return { message_id: p.message_id, stored_for_g2: true, physical_display_confirmed: false };
    });
  }

  subscribe(input: unknown) {
    return this.serial(async () => {
      const params = subscribeSchema.parse(input);
      callbackUrl(params.delivery.url, this.hosts); signingSecret(params.delivery.secret);
      const id = 'sub_' + createHash('sha256').update(JSON.stringify([SESSION, params.name, params.delivery.url])).digest('hex').slice(0, 32);
      const active = this.active();
      if (active && active.id !== id) throw new Error('This bridge already has a subscriber; unsubscribe it first');
      const sub = { id, url: params.delivery.url, secret: params.delivery.secret,
        expiresAt: Date.now() + (params.ttlMs ?? 3_600_000) };
      // Verify before storing; a rejected callback never becomes an active subscriber.
      await this.sender.verify(sub);
      this.state.subscription = sub; this.save();
      return { id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: null, truncated: false };
    });
  }
  unsubscribe(input: unknown) {
    return this.serial(async () => {
      const params = z.object({ name: z.literal('utterance.created'), arguments: argsSchema,
        delivery: deliverySchema.omit({ secret: true }) }).parse(input);
      if (this.state.subscription?.url === params.delivery.url) { delete this.state.subscription; this.save(); }
      return {};
    });
  }
  submit(input: unknown) {
    return this.serial(async () => {
      const { text, id } = z.object({ text: z.string().trim().min(1).max(4000), id: z.string().uuid() }).strict().parse(input);
      const existing = this.state.messages.find(item => item.id === id);
      if (existing) {
        if (existing.text !== text) throw new Error('Utterance ID already used for different text');
        return structuredClone(existing);
      }
      const sub = this.active();
      if (!sub) throw new Error('Dot has not subscribed; nothing was sent');
      const message: State['messages'][number] = { id, text, createdAt: new Date().toISOString(), status: 'pending' };
      this.latency.mark(id, 'utterance_created');
      this.state.messages.push(message);
      if (this.state.messages.length > 100) this.state.messages.shift();
      this.save();
      const event = { eventId: `evt_${id}`, name: 'utterance.created', timestamp: message.createdAt,
        data: { session_id: SESSION, utterance_id: id, text }, cursor: null };
      // One attempt in the initial proof. A timeout is not treated as an unsent message.
      // Client retries with the same ID return its stored status, preventing duplicates.
      try {
        this.latency.mark(id, 'webhook_sent');
        const result = await this.sender.send(sub, event.eventId, event);
        this.latency.mark(id, result.status >= 200 && result.status < 300 ? 'webhook_accepted' : 'webhook_failed');
        message.status = result.status >= 200 && result.status < 300 ? 'accepted' : 'failed';
        if (result.status === 410) delete this.state.subscription;
      } catch { this.latency.mark(id, 'webhook_failed'); message.status = 'failed'; }
      this.save(); return structuredClone(message);
    });
  }
  async reply(input: unknown) {
    const { utterance_id, text } = replySchema.parse(input);
    this.latency.mark(utterance_id, 'dot_reply_received');
    return this.serial(async () => {
      const message = this.state.messages.find(item => item.id === utterance_id);
      if (!message) throw new Error('Unknown utterance');
      if (message.reply !== undefined && message.reply !== text) throw new Error('Reply already exists; conflicting overwrite rejected');
      if (!message.reply) { message.reply = text; message.repliedAt = new Date().toISOString(); message.status = 'replied'; this.save(); this.latency.mark(utterance_id, 'reply_stored'); }
      return { utterance_id, delivered_to_bridge: true };
    });
  }
}
