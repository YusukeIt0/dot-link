import { t } from './i18n.ts';
export const REPLY_DELAY_MS = 60_000;
export interface DisplayMessage {
  id: string; text: string; reply?: string; status: string; createdAt?: string; repliedAt?: string; readAt?: string;
  kind?: 'notification' | 'proactive'; source_app?: string;
  photoCount?: number; photosExpired?: boolean;
}
export function waitingAge(message: DisplayMessage, now = Date.now()): number | undefined {
  if (message.kind || message.reply || message.status === 'failed' || message.photosExpired) return;
  const created = Date.parse(message.createdAt ?? '');
  return Number.isFinite(created) ? Math.max(0, now - created) : undefined;
}
export function delayedReply(message: DisplayMessage, now = Date.now()): boolean {
  return (waitingAge(message, now) ?? 0) >= REPLY_DELAY_MS;
}
export function receiptCaption(message?: DisplayMessage): string {
  if (!message || message.kind) return '';
  const at = new Date(message.createdAt ?? '');
  if (!Number.isFinite(at.getTime())) return '';
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `${t(message.readAt || message.reply ? 'even.read' : 'even.unread')} ${time}`;
}
export function newReplyCaption(count: number): string {
  return count > 0 ? t('even.new_replies', { count }) : '';
}
export function conversationText(message: DisplayMessage, now = Date.now(), assistantName = 'Dot'): string {
  if (message.kind === 'proactive') return message.reply ?? '';
  const sender = message.kind === 'notification' ? `${t('even.notification')} (${message.source_app ?? 'Mac'})` : t('even.you');
  const answer = message.reply ?? (message.photosExpired ? t('even.photos_expired_resend') : message.status === 'failed' ? t('even.could_not_confirm_delivery') :
    delayedReply(message, now) ? t('even.the_reply_is_taking_longer_than_usual') : t('even.waiting_for_a_reply'));
  const photos = message.photoCount ? t('even.photos_count', { count: message.photoCount }) : '';
  return `${sender}: ${[message.text, photos].filter(Boolean).join('\n')}\n\n${assistantName}: ${answer}`;
}
