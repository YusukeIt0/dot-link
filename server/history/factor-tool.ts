import { z } from 'zod';
import { decisionFactorTool } from '../context-guidance.ts';
import { ToolRejection } from '../tool-response.ts';
import { polarHistoryFields } from '../health/history.ts';
import { polarHistorySelection } from '../health/guidance.ts';
import { environmentFields } from './environment-fields.ts';
import { locationHistoryFields } from './location-fields.ts';
import { SEVEN_DAYS_MS } from './retention.ts';

export type HistoryPageInput = {
  start_at: string; end_at: string; known_at?: string; fields: readonly string[]; limit: number;
} | {cursor: string};
type HistoryReceipt = 'history_context_ids' | 'health_read_ids' | 'archive_read_ids';
export interface SelectedHistoryPage {
  status: string;
  entries: unknown[];
  next_cursor: string | null;
  response_context?: {arguments: Partial<Record<HistoryReceipt, string[]>>};
}
export interface SelectedHistoryReader {
  historyOwner(): string | undefined;
  readSelectedHistory(input: HistoryPageInput): SelectedHistoryPage;
  responseGuard(id: string): () => boolean;
}
interface HistorySource {
  fields: readonly string[];
  receipt: HistoryReceipt;
  forecastValidity?: boolean;
}

const limit = 50;
const instant = z.string().max(40).datetime({offset: true});
const changed = () => new ToolRejection('history_access_changed', 'Selected history is no longer available together. Reconsider with permitted evidence.');
const unavailable = (): SelectedHistoryPage => ({status: 'unavailable', entries: [], next_cursor: null});

/** Use the same declarations for discovery, input validation, and the final receipt check. */
export function createFactorHistoryContract(definitions: Readonly<Record<string, HistorySource>>) {
  const sources = Object.keys(definitions);
  const selections = Object.fromEntries(sources.map(source => {
    const values = definitions[source].fields;
    const selected = z.array(z.enum(values)).min(1).max(values.length)
      .refine(fields => new Set(fields).size === fields.length);
    return [source, selected.optional()];
  }));
  const querySchema = z.union([
    z.object({
      start_at: instant, end_at: instant, known_at: instant.optional(),
      fields: z.object(selections).strict().refine(fields => Object.values(fields).some(Boolean)),
      limit: z.number().int().min(1).max(limit).default(10),
    }).strict().refine(query => {
      const duration = Date.parse(query.end_at) - Date.parse(query.start_at);
      return duration > 0 && duration <= SEVEN_DAYS_MS;
    }),
    z.object({source: z.enum(sources), cursor: z.string().uuid()}).strict(),
  ]);

  const properties = Object.fromEntries(sources.map(source => {
    const fields = definitions[source].fields;
    return [source, {type: 'array', items: {type: 'string', enum: fields}, minItems: 1, maxItems: fields.length, uniqueItems: true}];
  }));
  const tool = decisionFactorTool({
    name: 'get_factor_history',
    description: `Read selected fields of locally saved, consented evidence for one explicit interval (up to seven days). For the first call, supply start_at, end_at and fields. For example, {"start_at":"2026-11-10T00:00:00Z","end_at":"2026-11-11T00:00:00Z","fields":{"polar":["steps"]}}. ${polarHistorySelection} Use one bounded query per comparison period. Location provides phone observations and attributed map references. A Polar daily total covers the whole source day; a missing record does not mean inactivity. For weather, precipitation selects MET forecast intervals. Select satellite_precipitation for separately saved NOAA nearby rain-rate estimates over the frame coverage window. known_at limits both to what the Mac had derived or received by that instant. Weather-only queries can select future MET forecast times. Missing satellite coverage gives no evidence of dryness, and separate frames alone do not establish rain movement or arrival. Mobility records represent requested plans and model terrain at the time they were available; they do not establish travel. Request detailed place, endpoints, steps or geometry only when relevant. Each source has its own coverage and guarded response_context. For continuation send only source and its returned next_cursor as cursor. No provider request, fresh location, setup or message is triggered. Use receipts from contributing sources with respond_to_context. Place, weather and route history require an existing question for a G2 announcement. Attribute material Polar or NOAA evidence naturally.`,
    inputSchema: {type: 'object', properties: {
      start_at: {type: 'string', format: 'date-time', maxLength: 40, description: 'Inclusive instant with explicit offset.'},
      end_at: {type: 'string', format: 'date-time', maxLength: 40, description: 'Exclusive instant with explicit offset.'},
      known_at: {type: 'string', format: 'date-time', maxLength: 40, description: 'Optional weather cutoff. Include only versions already available locally by this instant.'},
      fields: {type: 'object', properties, minProperties: 1, additionalProperties: false},
      limit: {type: 'integer', minimum: 1, maximum: limit, default: 10, description: 'Maximum entries per selected source.'},
      source: {type: 'string', enum: sources, description: 'Only for continuing one source page.'},
      cursor: {type: 'string', format: 'uuid', description: 'Only for continuation. Copy next_cursor from the requested source page.'},
    }, additionalProperties: false},
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  });

  function read(raw: unknown, readers: Partial<Record<string, SelectedHistoryReader>>, referenceTime = Date.now()) {
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) throw new ToolRejection('invalid_arguments', 'Select known fields in a positive interval up to seven days with offsets, or only a source and its returned cursor.');
    const query = parsed.data;
    const requested = 'cursor' in query ? [query.source] : sources.filter(source => query.fields[source]);
    let end: string | undefined;
    if ('start_at' in query) {
      const hasForecast = requested.some(source => definitions[source].forecastValidity);
      if (query.known_at && (!hasForecast || Date.parse(query.known_at) > referenceTime))
        throw new ToolRejection('invalid_arguments', 'Use known_at with weather evidence and a cutoff at or before the current time.');
      if (requested.some(source => !definitions[source].forecastValidity)) {
        if (Date.parse(query.start_at) >= referenceTime)
          throw new ToolRejection('invalid_arguments', 'Choose a historical period that has already begun.');
        if (Date.parse(query.end_at) > referenceTime) end = new Date(referenceTime).toISOString();
      }
    }
    const owners = new Map(requested.map(source => [source, readers[source]?.historyOwner()]));
    if (new Set([...owners.values()].filter(Boolean)).size > 1) throw changed();

    const pages: Record<string, SelectedHistoryPage> = {};
    for (const source of requested) {
      const reader = readers[source];
      const page = reader && owners.get(source)
        ? reader.readSelectedHistory('cursor' in query ? {cursor: query.cursor} : {
          start_at: query.start_at, end_at: end ?? query.end_at, fields: query.fields[source]!, limit: query.limit,
          ...(definitions[source].forecastValidity && query.known_at ? {known_at: query.known_at} : {}),
        }) : unavailable();
      pages[source] = page.status === 'unavailable' ? unavailable() : page;
    }
    // A later source read can invalidate evidence that the first source already selected.
    for (const source of requested) {
      const page = pages[source];
      if (page.status === 'unavailable') continue;
      const reader = readers[source]!;
      const ids = page.response_context?.arguments[definitions[source].receipt];
      if (!ids?.length || reader.historyOwner() !== owners.get(source) || !ids.every(id => reader.responseGuard(id)())) throw changed();
    }
    return {version: 1, ...('start_at' in query ? {window: {start_at: query.start_at, end_at: end ?? query.end_at},
      ...(query.known_at ? {known_at: query.known_at} : {}), ...(end ? {requested_end_at: query.end_at} : {})} : {}), sources: pages};
  }
  return {tool, read};
}

export const {tool: factorHistoryTool, read: readFactorHistory} = createFactorHistoryContract({
  location: {fields: locationHistoryFields, receipt: 'history_context_ids'},
  polar: {fields: polarHistoryFields, receipt: 'health_read_ids'},
  weather: {fields: environmentFields.weather, receipt: 'archive_read_ids', forecastValidity: true},
  mobility: {fields: environmentFields.mobility, receipt: 'archive_read_ids'},
});
