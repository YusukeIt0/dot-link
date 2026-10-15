import { getLanguage, t } from './i18n.ts';
export const REPLY_DELAY_MS = 60_000;
export interface DisplayMessage {
  id: string; text: string; reply?: string; status: string; createdAt?: string; repliedAt?: string; readAt?: string;
  kind?: 'notification' | 'proactive'; source_app?: string;
}
export function waitingAge(message: DisplayMessage, now = Date.now()): number | undefined {
  if (message.kind || message.reply || message.status === 'failed') return;
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
  return `${t(message.readAt || message.reply ? '既読' : '未読')} ${time}`;
}
export function newReplyCaption(count: number): string {
  return count > 0 ? getLanguage() === 'ja' ? `新着${count}件` : `${count} new` : '';
}
export function conversationText(message: DisplayMessage, now = Date.now(), assistantName = 'Dot'): string {
  if (message.kind === 'proactive') return message.reply ?? '';
  const sender = message.kind === 'notification' ? `${t('通知')} (${message.source_app ?? 'Mac'})` : t('あなた');
  const answer = message.reply ?? (message.status === 'failed' ? t('配送を確認できませんでした') :
    delayedReply(message, now) ? t('通常より返信に時間がかかっています…') : t('返信を待っています…'));
  return `${sender}: ${message.text}\n\n${assistantName}: ${answer}`;
}
