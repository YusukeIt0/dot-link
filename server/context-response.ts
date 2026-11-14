import { createHash } from 'node:crypto';
import { z } from 'zod';
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
  health_read_ids: ids.optional(), history_context_ids: ids.optional(),
  weather_read_ids: ids.optional(), mobility_read_ids: ids.optional(),
  disposition: z.enum(['silent', 'announce']), utterance_id: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(1800).optional(),
}).strict();
type Input = z.infer<typeof argumentsSchema>;
export interface ContextSources {
  locations?: LocationContext; health?: HealthContext; history?: HistoryReader; weather?: WeatherContext;
}
const idList = {type: 'array', items: {type: 'string', format: 'uuid'}, minItems: 1, maxItems: 8};
export const contextResponseTool = {
  name: 'respond_to_context',
  description: 'Deliver one natural G2 response using the permitted context that actually contributed to your reasoning or text, including evidence that changed your recommendation without being named. Use this when combining sources; it also supports one source. Supply only used receipts: context_id for current location/geography/attached weather, health_read_ids from health reads, history_context_ids from recent-place reads, weather_read_ids from explicit weather reads, mobility_read_ids from walking/terrain reads. Current-weather and mobility receipts also require their returned context_id. Do not fetch everything or attach unused reads. All contributing guards are rechecked in one commit. Include the original utterance_id for a question answer and follow-ups; omit it only for an independent proactive announcement. History-derived announcements still require an existing question. Choose silent when nothing warrants an interruption, omitting text and utterance_id; a question still deserves an answer using available evidence. Observe Polar attribution when health contributes. On source rejection, re-read only needed evidence and reconsider, or omit that source only after independently reconsidering the answer; never resend stale text through another route. Retry identical receipts, disposition, question and text. A conflict is not permission to change IDs. Storage does not prove physical display.',
  inputSchema: {type: 'object', properties: {
    context_id: {type: 'string', format: 'uuid'}, health_read_ids: idList, history_context_ids: idList,
    weather_read_ids: idList, mobility_read_ids: idList,
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
  private decisions = new Map<string, {signature: string; result: unknown}>();
  private send: Bridge['sendMessage'];
  constructor(send: Bridge['sendMessage']) { this.send = send; }
  respond(raw: unknown, sources: ContextSources) {
    const operation = this.tail.then(() => this.perform(raw, sources));
    this.tail = operation.catch(() => {}); return operation;
  }
  private async perform(raw: unknown, sources: ContextSources) {
    const parsed = argumentsSchema.safeParse(raw);
    if (!parsed.success) throw invalid();
    const p = parsed.data;
    if (!p.context_id && !p.health_read_ids && !p.history_context_ids && !p.weather_read_ids && !p.mobility_read_ids) throw invalid();
    if (p.disposition === 'silent' ? p.text !== undefined || p.utterance_id !== undefined : p.text === undefined) throw invalid();
    if (p.history_context_ids && p.disposition === 'announce' && !p.utterance_id)
      throw new ToolRejection('history_question_required', 'Historical evidence may inform reasoning, but a historical G2 announcement still requires an existing question. Do not bypass this boundary through another tool.');
    const guards: (() => boolean)[] = [];
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
      location = withLocation(() => sources.locations!.responseContext(p.context_id!));
      guards.push(() => withLocation(location!.guard));
    }
    for (const id of p.health_read_ids ?? []) {
      if (!sources.health) throw unavailable('health');
      guards.push(sources.health.responseGuard(id));
    }
    for (const id of p.history_context_ids ?? []) {
      if (!sources.history?.responseGuard) throw unavailable('history');
      guards.push(sources.history.responseGuard(id));
    }
    for (const id of p.weather_read_ids ?? []) {
      if (!sources.weather) throw unavailable('weather');
      const read = sources.weather.responseContext(id);
      if (read.contextId && read.contextId !== p.context_id) throw invalid();
      guards.push(() => withLocation(read.guard));
    }
    for (const id of p.mobility_read_ids ?? []) {
      if (!sources.locations) throw unavailable('mobility');
      const read = sources.locations.mobilityResponse(id);
      if (read.contextId !== p.context_id) throw invalid();
      guards.push(() => withLocation(read.guard));
    }
    const allowed = () => { for (const guard of guards) if (!guard()) throw new ToolRejection('context_access_changed', 'Used context changed. Re-read permitted evidence and reconsider.'); return true; };
    allowed();
    const message_id = responseId(p);
    const signature = JSON.stringify([p.disposition, p.text ?? null]);
    const prior = this.decisions.get(message_id);
    if (prior) {
      if (prior.signature !== signature) throw new ToolRejection('context_decision_conflict', 'This context decision already has different content. Retry only the original receipts, question, disposition and text.');
      return prior.result;
    }
    const result = p.disposition === 'silent' ? {disposition: 'silent', stored_for_g2: false} :
      await this.send({message_id, text: p.text!, ...(p.utterance_id ? {utterance_id: p.utterance_id} : {})}, allowed, location?.location);
    this.decisions.set(message_id, {signature, result});
    while (this.decisions.size > 1000) this.decisions.delete(this.decisions.keys().next().value!);
    location?.complete(message_id, p, result);
    return result;
  }
}
function responseId(p: Input) {
  const bytes = createHash('sha256').update(JSON.stringify(['dot-link:context-response:v1', p.context_id ?? null,
    p.health_read_ids ?? [], p.history_context_ids ?? [], p.weather_read_ids ?? [], p.mobility_read_ids ?? [], p.utterance_id ?? null])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
