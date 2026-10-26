import { ToolRejection } from './tool-response.ts';

const messages = {
  invalid_arguments: 'Invalid message arguments; use the tool schema with a UUID identifier and non-empty text of at most 8000 characters.',
  utterance_unknown: 'The utterance is unavailable; re-read pending utterances. Do not substitute a proactive message for this reply.',
  reply_conflict: 'A different reply already exists; do not overwrite it. Identical retries are allowed.',
  message_id_conflict: 'Message ID conflicts with an existing message; only identical retries are allowed. Do not change the ID merely to bypass this conflict.',
} as const;

export class BridgeResponseError extends ToolRejection {
  constructor(reason: keyof typeof messages) { super(reason, messages[reason]); }
}
