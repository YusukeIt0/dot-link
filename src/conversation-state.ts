import { reconcileHistory, NewReplyQueue } from './message-history.ts';
import type { DisplayMessage } from './conversation-display.ts';

export interface ConversationMessage extends DisplayMessage {
  location_sharing_id?: string;
  location_expires_at?: string;
}

/** Owns conversation decisions; returns effects without touching UI, speech or timers. */
export class ConversationState {
  private messages: ConversationMessage[] = [];
  private index = -1;
  private spoken = new Set<string>();
  private unread = new NewReplyQueue();
  private browsing = false;
  private pending = false;
  private restoreId: string | undefined;
  private restoring = false;
  private wakePending = false;
  private showingReply = false;
  private displayedId: string | undefined;

  get selected(): ConversationMessage | undefined { return this.messages[this.index]; }
  get visibleId(): string | undefined { return this.displayedId; }
  get visible(): ConversationMessage | undefined { return this.find(this.displayedId); }
  get count(): number { return this.messages.length; }
  get unreadCount(): number { return this.unread.count; }
  get hasPendingDisplay(): boolean { return this.pending; }
  find(id: string | undefined): ConversationMessage | undefined { return this.messages.find(message => message.id === id); }
  position(id: string): number { return this.messages.findIndex(message => message.id === id) + 1; }

  receive(snapshot: readonly ConversationMessage[], initial: boolean,
    mayAnnounce: (message: ConversationMessage) => boolean) {
    const selectedId = this.selected?.id;
    const update = reconcileHistory(this.messages, snapshot, initial, mayAnnounce);
    const announcements: ConversationMessage[] = [];
    for (const message of update.replies) {
      if (!message.reply || this.spoken.has(message.id)) continue;
      this.spoken.add(message.id); announcements.push(message);
    }
    if (announcements.length) this.wakePending = true;
    this.messages = update.messages;
    this.unread.retain(this.messages);
    if (initial) this.unread.clear(); else this.unread.receive(update.replies);
    if (selectedId) this.index = this.messages.findIndex(message => message.id === selectedId);
    while (this.spoken.size > 200) this.spoken.delete(this.spoken.values().next().value!);
    const latest = this.messages.at(-1);
    const waiting = initial && latest && !latest.reply && !latest.kind && latest.status !== 'failed' && !latest.photosExpired ? latest : undefined;
    if (initial && update.displayId) { this.restoreId = update.displayId; this.restoring = true; this.browsing = false; }
    this.pending = true;
    return { announcements, waiting };
  }

  flush(options: { allowed: boolean; hidden: boolean; mayAnnounce: (message: ConversationMessage) => boolean }): { display: boolean; wake: boolean } {
    if (!this.pending || !options.allowed) return { display: false, wake: false };
    this.pending = false;
    const target = this.restoring ? this.restoreId : this.unread.next(this.messages,
      this.showingReply ? this.visible : undefined, {
        hidden: options.hidden, browsingHistory: this.browsing,
        mayAnnounce: message => { const current = this.find(message.id); return !!current && options.mayAnnounce(current); },
      });
    this.restoreId = undefined;
    if (target) this.index = this.messages.findIndex(message => message.id === target);
    else if (this.visible?.reply) { this.unread.seen(this.displayedId!); this.showingReply = true; }
    this.restoring = false;
    const wake = this.wakePending; this.wakePending = false;
    return { display: !!target, wake };
  }

  navigate(direction: -1 | 1): void {
    this.index = direction < 0 ? Math.max(0, this.index - 1) : Math.min(this.messages.length - 1, this.index + 1);
    this.browsing = this.index < this.messages.length - 1;
  }
  selectedForDisplay(): ConversationMessage | undefined {
    const message = this.selected;
    if (message) this.unread.seen(message.id);
    return message;
  }
  present(id?: string): void {
    this.displayedId = id; this.showingReply = !!this.find(id)?.reply;
  }
  acceptSent(message: ConversationMessage): ConversationMessage {
    const saved = this.find(message.id);
    if (!saved) this.messages = reconcileHistory(this.messages, [...this.messages, message], true, () => true).messages;
    else if (!saved.reply) Object.assign(saved, message);
    this.index = this.messages.findIndex(item => item.id === message.id);
    this.browsing = false;
    return this.selected!;
  }

  reset(): void {
    this.messages = []; this.index = -1; this.spoken.clear(); this.unread.clear();
    this.browsing = false; this.pending = false; this.restoreId = undefined; this.restoring = false;
    this.wakePending = false; this.showingReply = false; this.displayedId = undefined;
  }
}
