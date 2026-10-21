export interface DisplayFrame { status: string; conversation: string; help: string; speech: string; receipt: string; newReplies: string; }
interface Options {
  ready: () => boolean;
  hidden: () => boolean;
  frame: () => DisplayFrame;
  writer: () => (id: number, name: string, content: string) => Promise<boolean>;
  failed: (kind: 'status' | 'frame') => void;
  timing: (id: string, stage: 'g2_update_started' | 'g2_update_ack' | 'g2_update_failed') => void;
  report: (id: string) => void;
}

/** The only queue writing G2 text containers; application code selects content. */
export class G2Display {
  private options: Options;
  private chain = Promise.resolve();
  private generation = 0;
  private stopped = false;
  private statusQueued = false;
  private statusDirty = false;
  private sent = new Map<number, string>();
  private reported = new Set<string>();
  constructor(options: Options) { this.options = options; }
  invalidate(): void { this.sent.clear(); }
  stop(): void { this.stopped = true; this.generation++; }
  private headers(frame: DisplayFrame): [number, string, string][] {
    return [[1, 'status', frame.status], [4, 'speech', frame.speech], [5, 'receipt', frame.receipt], [6, 'new', frame.newReplies]];
  }
  refreshStatus(): void {
    if (this.stopped || !this.options.ready() || this.options.hidden()) return;
    if (this.headers(this.options.frame()).every(([id, , content]) => content === this.sent.get(id))) return;
    if (this.statusQueued) { this.statusDirty = true; return; }
    this.statusQueued = true;
    const write = this.options.writer();
    this.chain = this.chain.then(async () => {
      if (this.stopped || this.options.hidden()) return;
      for (const [id, name] of this.headers(this.options.frame())) {
        if (this.stopped) return;
        // Read each field when it reaches the queue, as application state may
        // change while a preceding BLE write is in flight.
        const value = this.headers(this.options.frame()).find(([key]) => key === id)![2];
        if (value === this.sent.get(id)) continue;
        if (!await write(id, name, value || ' ')) throw new Error('Status update failed');
        this.sent.set(id, value);
      }
    }).catch(() => { if (!this.stopped) this.options.failed('status'); }).finally(() => {
      this.statusQueued = false;
      if (this.statusDirty) { this.statusDirty = false; this.refreshStatus(); }
    });
  }
  render(trace?: string): void {
    if (this.stopped || !this.options.ready()) return;
    const write = this.options.writer(), generation = ++this.generation;
    this.chain = this.chain.then(async () => {
      if (this.stopped || generation !== this.generation) return;
      if (trace) this.options.timing(trace, 'g2_update_started');
      const hidden = this.options.hidden(), frame = this.options.frame();
      const fields: [number, string, string][] = [[1, 'status', frame.status], [2, 'conversation', frame.conversation],
        [3, 'help', frame.help], [4, 'speech', frame.speech], [5, 'receipt', frame.receipt], [6, 'new', frame.newReplies]];
      for (const [id, name, value] of fields) {
        if (this.stopped || generation !== this.generation) return;
        const content = hidden ? ' ' : value || ' ';
        if (!await write(id, name, content)) throw new Error('G2 display update failed');
        if (id === 1 || id === 4) this.sent.set(id, content);
        if (id === 5 || id === 6) this.sent.set(id, content.trim());
      }
      if (!hidden && trace && generation === this.generation && !this.reported.has(trace)) {
        this.options.timing(trace, 'g2_update_ack'); this.reported.add(trace); this.options.report(trace);
        if (this.reported.size > 100) this.reported.delete(this.reported.values().next().value!);
      }
    }).catch(() => {
      if (this.stopped) return;
      if (trace) { this.options.timing(trace, 'g2_update_failed'); this.options.report(trace); }
      this.options.failed('frame');
    });
  }
}
