import { ToolRejection } from './tool-response.ts';

const messages = {
  invalid_arguments: 'Invalid notification arguments; use the tool schema with a UUID notification_id and the required text or disposition.',
  notification_unknown: 'The notification is unavailable; re-read pending notifications. Do not invent a replacement ID.',
  notification_silent: 'The notification was marked silent; do not bypass that decision with a proactive message.',
  announcement_conflict: 'A different announcement already exists; do not overwrite it. Identical retries are allowed.',
  notification_already_announced: 'The notification was already announced; it cannot be changed to later or silent.',
} as const;

export class NotificationResponseError extends ToolRejection {
  constructor(reason: keyof typeof messages) { super(reason, messages[reason]); }
}
