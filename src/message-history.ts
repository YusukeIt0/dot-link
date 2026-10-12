export interface HistoryMessage {
  id: string;
  reply?: string;
  status: string;
  createdAt?: string;
  repliedAt?: string;
  readAt?: string;
  location_sharing_id?: string;
  location_expires_at?: string;
}
const arrival = (message: HistoryMessage) => {
  const time = Date.parse((message.reply ? message.repliedAt : undefined) ?? message.createdAt ?? '');
  return Number.isFinite(time) ? time : 0;
};

/** History is durable context; announcement eligibility only controls new alerts. */
export function reconcileHistory<T extends HistoryMessage>(previous: readonly T[], snapshot: readonly T[],
  initial: boolean, mayAnnounce: (message: T) => boolean) {
  const before = new Map(previous.map(message => [message.id, message]));
  const messages = [...snapshot].sort((a, b) => arrival(a) - arrival(b));
  const replies = initial ? [] : messages.filter(message => message.reply && !before.get(message.id)?.reply && mayAnnounce(message));
  return { messages, replies, displayId: initial ? messages.at(-1)?.id : replies[0]?.id };
}

/** Holds arrival order without replacing a reply that is currently being read. */
export class NewReplyQueue {
  private ids: string[] = [];
  get count(): number { return this.ids.length; }
  clear(): void { this.ids = []; }
  receive(messages: readonly HistoryMessage[]): void {
    for (const message of messages) if (!this.ids.includes(message.id)) this.ids.push(message.id);
  }
  retain(messages: readonly HistoryMessage[]): void {
    const available = new Set(messages.map(message => message.id));
    this.ids = this.ids.filter(id => available.has(id));
  }
  seen(id: string): void { this.ids = this.ids.filter(item => item !== id); }
  next(messages: readonly HistoryMessage[], selected: HistoryMessage | undefined,
    options: { hidden: boolean; browsingHistory: boolean; mayAnnounce: (message: HistoryMessage) => boolean }): string | undefined {
    if (options.browsingHistory || (!options.hidden && selected?.reply)) return;
    const available = new Map(messages.map(message => [message.id, message]));
    return this.ids.find(id => {
      const message = available.get(id);
      return message && options.mayAnnounce(message);
    });
  }
}
