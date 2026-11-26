import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { G2DeliveryAvailability } from './g2-availability.ts';
import { ToolRejection } from './tool-response.ts';

const retentionPerKind = 1000;
const recordSchema = z.object({
  kind: z.enum(['question', 'message', 'notification']),
  id: z.string().uuid(),
  messageId: z.string().uuid().optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: z.string().uuid(),
  claimed: z.boolean(),
});
type Reservation = z.infer<typeof recordSchema>;
type DeliveryKind = Reservation['kind'];
const schema = z.object({version: z.literal(1), records: z.array(recordSchema).max(3 * retentionPerKind)});
const claim = z.object({receipt: z.string().uuid()}).strict();
interface Delivery {
  allowed: () => boolean;
  audience: string;
  text: string;
  question?: string;
  questionId?: string;
  messageId?: string;
}
interface Grant {
  delivery: Delivery;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
}
export function ownerChatDelivery(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'destination' in value && value.destination === 'owner_chat';
}
export function pendingChatHandoff(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'action' in value && value.action === 'claim_owner_chat_delivery';
}

export const chatDeliveryTool = {
  name: 'claim_owner_chat_delivery',
  description: 'When an existing Dot Link response returns owner_chat and this action, claim its receipt immediately. Only send_once_in_existing_owner_chat authorizes one native ChatGPT message in this same Dot’s existing owner conversation. Include the approved text and enough of any original question to identify the answer. Reconcile a returned native message ID using the official single-message lookup in that conversation. A duplicate or uncertain claim authorizes no further send. Answer questions asked in official chat directly there.',
  inputSchema: {type: 'object', properties: {receipt: {type: 'string', format: 'uuid'}}, required: ['receipt'], additionalProperties: false},
  annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
};

export const routingGuidance = 'The Mac selects a destination when the message is ready. For owner_chat, follow the returned action immediately in this Dot’s existing owner conversation. A G2 storage receipt completes that route. If the outcome is uncertain, keep the original identifiers and never send through the other channel. Direct questions in official chat stay in that chat.';

/** The disk ledger holds identifiers and a digest. Only a short-lived in-memory
 * grant can release the text, after checking its original source again. */
export class DeliveryRouting {
  private readonly path: string;
  private records: Reservation[] = [];
  private readable = true;
  private grants = new Map<string, Grant>();
  readonly availability: G2DeliveryAvailability;
  readonly ownerAuthorized: (owner: string) => boolean;

  constructor(path: string, availability: G2DeliveryAvailability, ownerAuthorized: (owner: string) => boolean) {
    this.path = path;
    this.availability = availability;
    this.ownerAuthorized = ownerAuthorized;
    try {
      this.records = schema.parse(JSON.parse(readFileSync(path, 'utf8'))).records;
    } catch (error) {
      // Leave an unreadable file for recovery and preserve ordinary history.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.readable = false;
    }
  }
  requireAvailable() {
    if (!this.readable) throw new ToolRejection('delivery_state_unavailable', 'The original delivery decision cannot be verified. Do not send the message through either route.');
  }
  find(kind: DeliveryKind, id: string) {
    return this.records.find(record => record.kind === kind && record.id === id);
  }
  outbound(id: string) {
    return this.records.find(record => record.messageId === id);
  }
  private digest(input: Delivery) {
    return createHash('sha256').update(JSON.stringify([input.audience, input.questionId ?? null, input.question ?? null, input.text])).digest('hex');
  }
  matches(entry: Reservation, input: Delivery) {
    return entry.digest === this.digest(input);
  }
  private write(records: Reservation[]) {
    const temporary = this.path + '.tmp';
    writeFileSync(temporary, JSON.stringify({version: 1, records}), {mode: 0o600});
    renameSync(temporary, this.path);
    this.records = records;
  }
  private forget(receipt: string) {
    clearTimeout(this.grants.get(receipt)?.timer);
    this.grants.delete(receipt);
  }
  reserve(kind: DeliveryKind, id: string, input: Delivery) {
    this.requireAvailable();
    if (!input.allowed()) throw new ToolRejection('delivery_access_changed', 'The original source or recipient changed. No new delivery is authorized.');
    let entry = this.find(kind, id);
    if (entry && !this.matches(entry, input)) throw new ToolRejection('delivery_conflict', 'This delivery belongs to different content or a different recipient. Keep the original identity.');
    if (!entry) {
      entry = {kind, id, digest: this.digest(input), receipt: randomUUID(), claimed: false, messageId: input.messageId};
      const sameKind = this.records.filter(record => record.kind === kind);
      const oldest = sameKind.length >= retentionPerKind ? sameKind[0] : undefined;
      this.write([...this.records.filter(record => record !== oldest), entry]);
      if (oldest) this.forget(oldest.receipt);
    }
    if (!entry.claimed) {
      const receipt = entry.receipt;
      this.forget(receipt);
      const lifetime = 120_000;
      const timer = setTimeout(() => this.forget(receipt), lifetime);
      timer.unref();
      this.grants.set(receipt, {delivery: input, timer, deadline: performance.now() + lifetime});
    }
    return {destination: 'owner_chat' as const, stored_for_g2: false, native_delivery_confirmed: false,
      ...(entry.claimed ? {action: 'do_not_resend' as const} : {action: 'claim_owner_chat_delivery' as const, receipt: entry.receipt})};
  }
  take(raw: unknown) {
    this.requireAvailable();
    const parsed = claim.safeParse(raw);
    if (!parsed.success) throw new ToolRejection('invalid_arguments', 'Use the receipt from the original Dot Link decision.');
    const entry = this.records.find(record => record.receipt === parsed.data.receipt);
    if (!entry) throw new ToolRejection('delivery_unknown', 'The original delivery receipt is unavailable. Do not send through another route.');
    if (entry.claimed) return {destination: 'owner_chat', action: 'do_not_resend', native_delivery_confirmed: false};
    const grant = this.grants.get(entry.receipt);
    let permitted = false;
    if (grant && performance.now() < grant.deadline) {
      try { permitted = grant.delivery.allowed(); }
      catch (error) { this.forget(entry.receipt); throw error; }
    }
    if (!grant || !permitted) {
      this.forget(entry.receipt);
      throw new ToolRejection('delivery_access_changed', 'Repeat the original guarded decision with the same ID. A current source and recipient must authorize the handoff.');
    }
    // Persist before releasing the only permission for an external send. A lost
    // tool response can leave the native outcome unknown, even after restart.
    this.write(this.records.map(record => record === entry ? {...record, claimed: true} : record));
    this.forget(entry.receipt);
    const {text, question, questionId} = grant.delivery;
    return {destination: 'owner_chat', action: 'send_once_in_existing_owner_chat', text,
      ...(questionId ? {utterance_id: questionId, original_question: question} : {}), native_delivery_confirmed: false};
  }
}
