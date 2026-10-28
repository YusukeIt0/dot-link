/** Fixed, non-sensitive response vocabulary; safe for future opt-in diagnostics. */
const messages = {
  invalid_arguments: 'Invalid location response arguments; use a UUID context_id and silent or announce. Omit text and utterance_id for silent; announce requires non-empty text. A question reference must be a UUID.',
  utterance_unknown: 'The question is unavailable; re-read pending utterances. Do not omit the question reference or substitute an independent announcement to bypass this rejection.',
  text_not_allowed_for_silent: 'Silent decisions must omit text; retry without text.',
  text_required_for_announcement: 'Announcements require non-empty text.',
  sharing_inactive: 'Location sharing is inactive; wait until sharing resumes before reading context again.',
  context_unknown: 'Location context is no longer available; read context again and reconsider.',
  context_expired: 'Location is stale; read context again and reconsider when fresh data is available.',
  moved_too_far: 'The latest position differs by more than 100 metres; read context again and reconsider.',
  conflicting_decision: 'This context already has a different decision; do not overwrite it. Identical retries are allowed.',
  internal_error: 'Location response could not be completed; an internal error occurred.',
} as const;

export type LocationResponseReason = keyof typeof messages;

export class LocationResponseError extends Error {
  readonly reason: LocationResponseReason;
  constructor(reason: LocationResponseReason) {
    super(messages[reason]);
    this.name = 'LocationResponseError';
    this.reason = reason;
  }
}
