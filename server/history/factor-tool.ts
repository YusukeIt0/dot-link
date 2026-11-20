import { z } from 'zod';
import { decisionFactorTool } from '../context-guidance.ts';
import { ToolRejection } from '../tool-response.ts';
import { polarHistoryFields } from '../health/history.ts';
import { locationHistoryFields } from './location-fields.ts';
import { SEVEN_DAYS_MS } from './retention.ts';

const sources = ['location', 'polar'] as const;
type Source = typeof sources[number];
export type HistoryPageInput = {start_at: string; end_at: string; fields: readonly string[]; limit: number} | {cursor: string};
export interface SelectedHistoryPage {
  status: string;
  entries: unknown[];
  next_cursor: string | null;
  response_context?: {arguments: {history_context_ids?: string[]; health_read_ids?: string[]}};
}
export interface SelectedHistoryReader {
  historyOwner(): string | undefined;
  readSelectedHistory(input: HistoryPageInput): SelectedHistoryPage;
  responseGuard(id: string): () => boolean;
}
type Readers = Partial<Record<Source, SelectedHistoryReader>>;

const limit = 50;
const fieldList = (values: readonly [string, ...string[]]) => z.array(z.enum(values)).min(1).max(values.length)
  .refine(fields => new Set(fields).size === fields.length);
const instant = z.string().max(40).datetime({offset: true});
const windowQuery = z.object({
  start_at: instant, end_at: instant,
  fields: z.object({location: fieldList(locationHistoryFields).optional(), polar: fieldList(polarHistoryFields).optional()})
    .strict().refine(fields => fields.location || fields.polar),
  limit: z.number().int().min(1).max(limit).default(10),
}).strict().refine(query => {
  const duration = Date.parse(query.end_at) - Date.parse(query.start_at);
  return duration > 0 && duration <= SEVEN_DAYS_MS;
});
const querySchema = z.union([windowQuery, z.object({source: z.enum(sources), cursor: z.string().uuid()}).strict()]);
const fieldSchema = (values: readonly string[]) => ({
  type: 'array', items: {type: 'string', enum: values}, minItems: 1, maxItems: values.length, uniqueItems: true,
});
export const factorHistoryTool = decisionFactorTool({
  name: 'get_factor_history',
  description: 'Read only the selected fields of saved location and/or Polar evidence for the same explicit interval (up to seven days). Use another bounded query to compare periods. Select location position for coordinates/accuracy, motion for speed/heading, clock for phone time evidence, or geography for attributed nearby map references. Select Polar metrics by name. Result version 1 gives each requested source its own entries, coverage and guarded response_context. An offset-free Polar date can partially overlap the interval; a daily total is for its source day. Missing records and stopped sharing are normal. Do not ask the person to fill gaps. To continue one source, send only its source and next_cursor. No provider request, setup, live fix or message is triggered by this read. Use the receipts of contributing sources with respond_to_context. Location history still requires an existing question for a G2 reply. Use Polar attribution when its data contributes.',
  inputSchema: {type: 'object', properties: {
    start_at: {type: 'string', format: 'date-time', maxLength: 40, description: 'Inclusive instant with explicit offset.'},
    end_at: {type: 'string', format: 'date-time', maxLength: 40, description: 'Exclusive instant with explicit offset.'},
    fields: {type: 'object', properties: {location: fieldSchema(locationHistoryFields), polar: fieldSchema(polarHistoryFields)},
      minProperties: 1, additionalProperties: false},
    limit: {type: 'integer', minimum: 1, maximum: limit, default: 10, description: 'Maximum entries per selected source.'},
    source: {type: 'string', enum: sources, description: 'Only for continuing one source page.'},
    cursor: {type: 'string', format: 'uuid'},
  }, oneOf: [
    {required: ['start_at', 'end_at', 'fields'], properties: {source: false, cursor: false}},
    {required: ['source', 'cursor'], properties: {start_at: false, end_at: false, fields: false, limit: false}},
  ], additionalProperties: false},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
});

const changed = () => new ToolRejection('history_access_changed', 'Selected history is no longer available together. Reconsider with permitted evidence.');
const unavailable = (): SelectedHistoryPage => ({status: 'unavailable', entries: [], next_cursor: null});

export function readFactorHistory(raw: unknown, readers: Readers, referenceTime = Date.now()) {
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) throw new ToolRejection('invalid_arguments', 'Specify a positive interval up to seven days with offsets and selected fields, or only a source and its returned cursor.');
  const query = parsed.data;
  if ('start_at' in query && Date.parse(query.start_at) >= referenceTime)
    throw new ToolRejection('invalid_arguments', 'Choose a historical period that has already begun.');
  // "Today" may end tonight. Date-only evidence must not make a future period look observed.
  const end = 'end_at' in query && Date.parse(query.end_at) > referenceTime ? new Date(referenceTime).toISOString() : undefined;
  const requested = 'cursor' in query ? [query.source] : sources.filter(source => query.fields[source]);
  const owners = new Map(requested.map(source => [source, readers[source]?.historyOwner()]));
  if (new Set([...owners.values()].filter(Boolean)).size > 1) throw changed();

  const pages: Partial<Record<Source, SelectedHistoryPage>> = {};
  for (const source of requested) {
    const reader = readers[source];
    pages[source] = reader && owners.get(source)
      ? reader.readSelectedHistory('cursor' in query ? {cursor: query.cursor} : {
        start_at: query.start_at, end_at: end ?? query.end_at, fields: query.fields[source]!, limit: query.limit,
      }) : unavailable();
  }
  // A later source read can invalidate evidence that the first source already selected.
  for (const source of requested) {
    const page = pages[source]!;
    if (page.status === 'unavailable') continue;
    const reader = readers[source]!;
    const args = page.response_context?.arguments;
    const ids = source === 'location' ? args?.history_context_ids : args?.health_read_ids;
    if (!ids?.length || reader.historyOwner() !== owners.get(source) || !ids.every(id => reader.responseGuard(id)())) throw changed();
  }
  return {version: 1, ...('start_at' in query ? {window: {start_at: query.start_at, end_at: end ?? query.end_at},
    ...(end ? {requested_end_at: query.end_at} : {})} : {}), sources: pages};
}
