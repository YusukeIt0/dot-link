import { toolResponse } from './tool-response.ts';

/** Product guidance, separate from untrusted map/provider labels and observations. */
export const evidencePresentation = 'Keep accuracy, source, timestamps, missing values and model limitations in your reasoning. Mention uncertainty only when it materially changes the answer, choice or action, and describe that concrete consequence briefly. A generic possibility of error is not a material consequence: do not append hypothetical local-weather, map-accuracy or venue-inference caveats when the available evidence gives no specific reason they affect this answer. Give the useful answer and stop; do not add routine verification chores such as checking the sky solely because forecasts are models. Do not routinely preface answers with numerical accuracy or model-versus-reality disclaimers. Treat limits on inferring a venue entry, visit, gaze or road membership as internal reasoning constraints, not recurring disclaimers. Do not volunteer that location cannot prove a visit. Usually answer using only supported facts; ask whether a visit occurred only when that distinction materially changes the answer and cannot be resolved from the conversation. Never turn uncertain evidence into a verified fact.';

export const contextActivityGuidance = {
  selection: 'Within the existing activity, choose permitted context that helps the current purpose and conversation; no separate user question or task per source is needed. Do not fetch every source on every update. Use the included geography and weather first; get_weather_context can supply relevant additional forecast evidence. For a walk, use get_mobility_context when a known destination, slope or terrain matters; never invent a destination. Use get_location_history when recent place or movement context would help and conversation/memory alone is insufficient. Use get_health_context for relevant permitted sleep, activity or recovery context; combine it with the conversation and other helpful factors. Missing optional data is normal: continue without repeated settings prompts. Do not invent interests or goals. Choose silence when nothing useful merits an interruption.',
  presentation: evidencePresentation,
  response: 'Use respond_to_context once when combining sources. Each available result supplies response_context with its argument mapping and a latest possible expiry; access can end earlier. Merge only the mappings for used evidence. Include receipts for all evidence that materially influenced your reasoning or text, not everything fetched. Use context_id for current location/geography/attached weather; add weather_read_ids or mobility_read_ids for explicit weather or walking/terrain reads and their returned context_id when current-location based. Include health_read_ids and history_context_ids when used. Include the original utterance_id for question answers and follow-ups. Historical G2 announcements still require an existing question; reading history does not authorize proactive historical claims. Silent omits text and utterance_id, writes no message, and does not replace an answer to a user question. On rejection, re-read needed evidence and reconsider or remain silent; never bypass it by sending stale text through another tool. Individual-source location, health and history replies may still use their respective respond_to_location, respond_to_health and respond_to_history tools. Observe all consent, freshness and attribution rules',
} as const;

/** Short cross-factor contract delivered even when a host caches old descriptions. */
export const conversationGuidance = {
  version: 2,
  response: contextActivityGuidance.response,
  presentation: 'Use permitted evidence with the person’s purpose, conversation and preferences to decide what helps them understand, choose or act. Keep the same natural conversation across decision factors. Choose useful numbers (including temperature, humidity, time and distance), explanations or suggestions at the level of detail the request needs; neither recite all fields nor suppress numbers. Keep provider names, attribution and acquisition details as evidence; explain them when asked or when they matter to the answer, rather than routinely reading them aloud. Preserve consequential uncertainty and never invent missing facts. Missing optional data is normal. Do not fetch every factor, force advice or interrupt without value. Keep all consent, freshness and response guards.',
} as const;

export function decisionFactorTool<T extends {description: string}>(tool: T): T {
  return {...tool, description: `${tool.description} ${conversationGuidance.presentation} ${contextActivityGuidance.response} ${evidencePresentation}`};
}

/** Decorate only selected factor reads, without changing acquisition or rejection semantics. */
export async function decisionFactorResponse(action: () => unknown | Promise<unknown>) {
  const response = await toolResponse(async () => {
    const value = await action();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid factor result');
    return {...value, conversation_guidance: conversationGuidance};
  });
  if (response.error) {
    return {error: {...response.error, data: {...response.error.data, conversation_guidance: conversationGuidance}}};
  }
  return response;
}
