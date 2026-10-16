// Opt-in development diagnostics: fixed labels only, no payloads or identifiers.
const KEY = 'dot-exit-check-v1';
const events = ['boot', 'ready', 'pagehide', 'pageshow', 'hidden', 'visible', 'dialog-request', 'dialog-opened', 'dialog-failed',
  'sys-exit', 'sys-abnormal', 'text-exit', 'text-abnormal', 'list-exit', 'list-abnormal', 'exit-after-stop', 'exit-reason',
  'foreground-enter', 'foreground-exit', 'system-exit', 'abnormal-exit', 'stop-session',
  'share-enable', 'share-disable', 'share-fix', 'share-heartbeat', 'share-ok', 'share-failed'] as const;
export type ExitCheckEvent = typeof events[number];
type Row = {run: string; at: number; event: ExitCheckEvent};
type Options = {enabled: boolean; storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  changed: (text: string) => void; log: (text: string) => void; now?: () => number};
export class ExitDiagnostics {
  private run: string;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
    this.run = Math.random().toString(36).slice(2, 8);
  }
  private rows(): Row[] {
    try {
      const rows = JSON.parse(this.options.storage().getItem(KEY) ?? '[]');
      if (!Array.isArray(rows)) return [];
      return rows.filter((r: Row) => r && /^[a-z0-9]{1,6}$/.test(r.run) && Number.isFinite(r.at) && events.includes(r.event)).slice(-47)
        .map(({run, at, event}: Row) => ({run, at, event}));
    } catch { return []; }
  }
  observe(event: {sysEvent?: {eventType?: number; systemExitReasonCode?: number}; textEvent?: {eventType?: number}; listEvent?: {eventType?: number}}, stopped: boolean): void {
    if (!this.options.enabled) return;
    let exit = false;
    for (const [field, name] of [[event.sysEvent, 'sys'], [event.textEvent, 'text'], [event.listEvent, 'list']] as const) {
      if (field?.eventType === 7 || field?.eventType === 6) {
        this.record(`${name}-${field.eventType === 7 ? 'exit' : 'abnormal'}`); exit = true;
      }
    }
    if (event.sysEvent?.systemExitReasonCode !== undefined) this.record('exit-reason');
    if (exit && stopped) this.record('exit-after-stop');
  }
  record(event: ExitCheckEvent): void {
    if (!this.options.enabled || !events.includes(event)) return;
    try {
      const row = {run: this.run, at: (this.options.now ?? Date.now)(), event};
      const rows = [...this.rows(), row];
      let saved = true;
      try { this.options.storage().setItem(KEY, JSON.stringify(rows)); } catch { saved = false; }
      const line = (r: Row) => `${new Date(r.at).toISOString().slice(11, 19)} ${r.run} ${r.event}`;
      this.options.log(`[exit-check] ${line(row)}`);
      this.options.changed(`Exit check (UTC${saved ? '' : ', storage unavailable'})\n${rows.map(line).join('\n')}`);
    } catch { /* Diagnostics must never interrupt the app or its stop path. */ }
  }
}
