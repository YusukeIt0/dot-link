import { pendingChatHandoff } from './delivery-routing.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { healthCheckIn } from './health/guidance.ts';
import type { Bridge } from './bridge.ts';
import type { HealthContext } from './health/context.ts';
import type { HistoryReader } from './history/tool.ts';
import type { LocationContext } from './location.ts';
import type { WeatherContext } from './weather/context.ts';
import { LocationResponseError } from './location-response-error.ts';
import { ToolRejection } from './tool-response.ts';

const ids = z.array(z.string().uuid()).min(1).max(8).transform(value => [...new Set(value)].sort());
const argumentsSchema = z.object({
  context_id: z.string().uuid().optional(),
  activity_id: z.string().trim().min(1).max(160).optional(),
  health_read_ids: ids.optional(), history_context_ids: ids.optional(),
  weather_read_ids: ids.optional(), mobility_read_ids: ids.optional(), archive_read_ids: ids.optional(),
  disposition: z.enum(['silent', 'announce']), utterance_id: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(1800).optional(),
}).strict();
type Input = z.infer<typeof argumentsSchema>;
export interface ContextSources {
  locations?: LocationContext; health?: HealthContext; history?: HistoryReader; weather?: WeatherContext;
  archives?: {responseContext(id: string): {owner: string; guard: () => boolean; recallAllowed?: () => boolean} | undefined};
}
const idList = {type: 'array', items: {type: 'string', format: 'uuid'}, minItems: 1, maxItems: 8};
export const contextResponseTool = {
  name: 'respond_to_context',
  description: `Deliver one natural G2 response using the permitted context that actually contributed to your reasoning or text, including evidence that changed your recommendation without being named. Use this when combining sources; it also supports one source. Supply only used receipts: context_id for current location/geography/attached weather, health_read_ids from health reads, history_context_ids from recent-place reads, weather_read_ids from explicit weather reads, mobility_read_ids from live walking/terrain reads, and archive_read_ids from historical weather and route reads. Live current-weather and mobility receipts also require their returned context_id. Do not fetch everything or attach unused reads. All contributing guards are rechecked in one commit. Include the original utterance_id for a question answer and follow-ups; omit it only for an independent proactive announcement. Follow conversation_guidance.response from the factor read for activity decisions. On an activity retry, reuse the original activity_id. Choose silent when nothing warrants an interruption, omitting text and utterance_id; a question still deserves an answer using available evidence. Observe Polar attribution when health contributes. ${healthCheckIn} On source rejection, re-read only needed evidence and reconsider, or omit that source only after independently reconsidering the answer; never resend stale text through another route. Retry identical receipts, disposition, question and text. A conflict is not permission to change IDs. Storage does not prove physical display.`,
  inputSchema: {type: 'object', properties: {
    context_id: {type: 'string', format: 'uuid'}, health_read_ids: idList, history_context_ids: idList,
    activity_id: {type: 'string', minLength: 1, maxLength: 160, description: 'Stable ID of this unprompted occurrence. Copy the triggering update_id, or use the activity run ID or its name and scheduled UTC occurrence. Keep the same value on every read and retry. Omit on question answers.'},
    weather_read_ids: idList, mobility_read_ids: idList, archive_read_ids: idList,
    disposition: {type: 'string', enum: ['silent', 'announce']},
    utterance_id: {type: 'string', format: 'uuid'}, text: {type: 'string', minLength: 1, maxLength: 1800},
  }, required: ['disposition'], additionalProperties: false},
  annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
};
const invalid = () => new ToolRejection('invalid_arguments', 'Supply at least one used context receipt. Announce requires text; silent omits text and utterance_id. Current weather and mobility also require their context_id.');
const unavailable = (source: string) => new ToolRejection(`${source}_unavailable`, `The ${source} response guard is unavailable. Refresh tools/list and reconsider with available context.`);

/** Only joins existing source guards and the existing single-message commit. No AI policy engine. */
export class ContextResponder {
  private tail: Promise<unknown> = Promise.resolve();
  private decisions = new Map<string, {receiptKey: string; signature: string; result: unknown}>();
  private send: Bridge['sendMessage'];
  private hasStoredMessage: (id: string) => boolean;
  constructor(send: Bridge['sendMessage'], hasStoredMessage = (_id: string) => false) {
    this.send = send;
    this.hasStoredMessage = hasStoredMessage;
  }
  respond(raw: unknown, sources: ContextSources) {
    const operation = this.tail.then(() => this.perform(raw, sources));
    this.tail = operation.catch(() => {}); return operation;
  }
  private async perform(raw: unknown, sources: ContextSources) {
    const parsed = argumentsSchema.safeParse(raw);
    if (!parsed.success) throw invalid();
    const p = parsed.data;
    if (!p.context_id && !p.health_read_ids && !p.history_context_ids && !p.weather_read_ids && !p.mobility_read_ids && !p.archive_read_ids) throw invalid();
    if (p.disposition === 'silent' ? p.text !== undefined || p.utterance_id !== undefined : p.text === undefined) throw invalid();
    if (p.activity_id && p.utterance_id) throw invalid();
    if (!p.utterance_id && !p.context_id && !p.activity_id && p.disposition === 'announce' && (p.history_context_ids || p.archive_read_ids))
      throw new ToolRejection('activity_id_required', 'Supply the original event or activity occurrence for this unprompted decision. Keep it across retries and fresh reads.');
    // Always acquire location before health; individual routes acquire only their own lock.
    const commit = () => p.health_read_ids && sources.health
      ? sources.health.withResponseLock(() => this.commit(p, sources)) : this.commit(p, sources);
    return p.context_id && sources.locations ? sources.locations.withResponseLock(commit) : commit();
  }
  private async commit(p: Input, sources: ContextSources) {
    const guards: (() => boolean)[] = [];
    const recallGuards: (() => boolean)[] = [];
    const owners: (() => string | undefined)[] = [];
    let location: ReturnType<LocationContext['responseContext']> | undefined;
    // Location errors have their own legacy transport. Normalize only this route.
    const withLocation = <T>(action: () => T): T => {
      try { return action(); } catch (error) {
        if (error instanceof LocationResponseError) throw new ToolRejection(`location_${error.reason}`, error.message);
        throw error;
      }
    };
    if (p.context_id) {
      if (!sources.locations) throw unavailable('location');
      location = withLocation(() => sources.locations!.responseContext(p.context_id!, p.utterance_id));
      guards.push(() => withLocation(location!.guard));
      recallGuards.push(location.recallAllowed);
      owners.push(() => location!.owner);
    }
    const healthDecisions: ReturnType<HealthContext['responseContext']>[] = [];
    for (const id of p.health_read_ids ?? []) {
      if (!sources.health) throw unavailable('health');
      const read = sources.health.responseContext(id);
      guards.push(read.guard); healthDecisions.push(read);
      recallGuards.push(read.recallAllowed);
    }
    for (const id of p.history_context_ids ?? []) {
      if (!sources.history?.responseGuard) throw unavailable('history');
      const guard = sources.history.responseGuard(id);
      guards.push(guard);
      recallGuards.push(sources.history.recallGuard?.(id) ?? guard);
    }
    if (p.health_read_ids) owners.push(() => sources.health?.historyOwner());
    if (p.history_context_ids) owners.push(() => sources.history?.historyOwner?.());
    for (const id of p.archive_read_ids ?? []) {
      if (!sources.archives) throw unavailable('archive');
      const read = sources.archives.responseContext(id);
      if (!read) throw new ToolRejection('archive_context_unknown', 'The historical read expired or its access changed. Re-read permitted evidence and reconsider.');
      guards.push(read.guard);
      recallGuards.push(read.recallAllowed ?? read.guard);
      owners.push(() => read.owner);
    }
    const weatherDecisions = new Set<string>();
    for (const id of p.weather_read_ids ?? []) {
      if (!sources.weather) throw unavailable('weather');
      const read = sources.weather.responseContext(id);
      weatherDecisions.add(read.decisionId);
      if (read.contextId && read.contextId !== p.context_id) throw invalid();
      guards.push(() => withLocation(read.guard));
      recallGuards.push(read.recallAllowed);
      owners.push(() => read.owner);
    }
    for (const id of p.mobility_read_ids ?? []) {
      if (!sources.locations) throw unavailable('mobility');
      const read = sources.locations.mobilityResponse(id);
      if (read.contextId !== p.context_id) throw invalid();
      guards.push(() => withLocation(read.guard));
      // Mobility consent belongs to the same location sharing generation.
    }
    if (owners.length > 1) guards.push(() => {
      const first = owners[0]();
      return !!first && owners.slice(1).every(current => current() === first);
    });
    const allowed = () => { for (const guard of guards) if (!guard()) throw new ToolRejection('context_access_changed', 'Used context changed. Re-read permitted evidence and reconsider.'); return true; };
    allowed();
    // Both weather mappings come from one read. Switching mappings cannot
    // commit another message or evade a conflicting decision for that read.
    const receiptKey = responseId({...p, weather_read_ids: [...weatherDecisions].sort()});
    const owner = owners[0]?.();
    if (p.activity_id && !owner) throw new ToolRejection('context_access_changed', 'The activity no longer has an authorized source owner.');
    const activityKey = p.activity_id ? uuidFor(['dot-link:activity:v1', owner, p.activity_id]) : undefined;
    const decisionKey = activityKey ?? receiptKey;
    const message_id = activityKey ?? location?.decisionId ?? receiptKey;
    const signature = JSON.stringify([p.disposition, p.text ?? null]);
    const healthSignature = JSON.stringify(['combined', receiptKey, signature]);
    for (const read of healthDecisions) if (read.previous && read.previous.signature !== healthSignature)
      throw new ToolRejection('context_decision_conflict', 'This health read already has a different decision. Retry the original route and receipts, or read fresh evidence for a new question.');
    if (location?.previous) {
      const previous = location.previous;
      if (previous.receiptKey !== receiptKey || previous.disposition !== p.disposition || previous.text !== p.text)
        throw new ToolRejection('context_decision_conflict', 'This location already has a different decision. Retry only the original receipts, question, disposition and text.');
      if (!pendingChatHandoff(previous.result)) return previous.result;
    }
    const prior = this.decisions.get(decisionKey);
    if (prior) {
      if (prior.receiptKey !== receiptKey || prior.signature !== signature) throw new ToolRejection('context_decision_conflict', 'This occurrence already has a decision. Retry only the original receipts, disposition and text.');
      if (!pendingChatHandoff(prior.result)) return prior.result;
    }
    if (activityKey && p.disposition === 'silent' && this.hasStoredMessage(message_id))
      throw new ToolRejection('context_decision_conflict', 'An announcement was already stored for this occurrence.');
    const result = p.disposition === 'silent' ? {disposition: 'silent', stored_for_g2: false} :
      await this.send({message_id, text: p.text!, ...(p.utterance_id ? {utterance_id: p.utterance_id} : {})}, allowed, location?.location,
        () => recallGuards.every(check => check()), owner);
    this.decisions.set(decisionKey, {receiptKey, signature, result});
    while (this.decisions.size > 1000) this.decisions.delete(this.decisions.keys().next().value!);
    location?.complete(location.decisionId, {...p, receiptKey}, result);
    for (const read of healthDecisions) read.complete(healthSignature, result);
    return result;
  }
}
function responseId(p: Input) {
  return uuidFor(['dot-link:context-response:v1', p.context_id ?? null,
    p.health_read_ids ?? [], p.history_context_ids ?? [], p.weather_read_ids ?? [], p.mobility_read_ids ?? [], p.utterance_id ?? null,
    ...(p.archive_read_ids ? [p.archive_read_ids] : []), ...(p.activity_id ? [{activity_id: p.activity_id}] : [])]);
}
function uuidFor(parts: unknown[]) {
  const bytes = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
