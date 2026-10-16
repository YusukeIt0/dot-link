// Opt-in development diagnostics: fixed labels only, no payloads or identifiers.
const KEY = 'dot-exit-check-v1';
const events = ['boot', 'ready', 'pagehide', 'pageshow', 'hidden', 'visible', 'dialog-request', 'dialog-opened', 'dialog-failed',
  'sys-exit', 'sys-abnormal', 'text-exit', 'text-abnormal', 'list-exit', 'list-abnormal', 'exit-after-stop', 'exit-reason',
  'foreground-enter', 'foreground-exit', 'system-exit', 'abnormal-exit', 'stop-session',
  'share-enable', 'share-disable', 'share-fix', 'share-heartbeat', 'share-ok', 'share-failed'] as const;
export type ExitCheckEvent = typeof events[number];
type Row = {run: string; at: number; event: ExitCheckEvent};
type NativeStorage = {getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<boolean>};
type Options = {enabled: boolean; storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  changed: (text: string) => void; log: (text: string) => void; now?: () => number};
function parse(raw: string | null): Row[] {
  try {
    if (!raw || raw.length > 20000) return [];
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return [];
    return rows.filter((r: Row) => r && /^[a-z0-9]{1,6}$/.test(r.run) && Number.isFinite(r.at) && events.includes(r.event)).slice(-48)
      .map(({run, at, event}: Row) => ({run, at, event}));
  } catch { return []; }
}
export class ExitDiagnostics {
  private run: string;
  private options: Options;
  private memory: Row[] = [];
  private native?: NativeStorage;
  private nativeReady = false;
  private nativeState: 'pending' | 'saved' | 'failed' = 'pending';
  private dirty = false;
  private writing = false;
  private localSaved = true;
  constructor(options: Options) {
    this.options = options;
    this.run = Math.random().toString(36).slice(2, 8);
  }
  private rows(): Row[] {
    try { return parse(this.options.storage().getItem(KEY)); } catch { return this.memory; }
  }
  private save(rows: Row[]): void {
    this.memory = rows.slice(-48);
    try { this.options.storage().setItem(KEY, JSON.stringify(this.memory)); this.localSaved = true; }
    catch { this.localSaved = false; }
  }
  private render(): void {
    try {
      const line = (r: Row) => `${new Date(r.at).toISOString().slice(11, 19)} ${r.run} ${r.event}`;
      this.options.changed(`Exit check (UTC, newest first; native ${this.nativeState}${this.localSaved ? '' : '; local unavailable'})\n${[...this.memory].reverse().map(line).join('\n')}`);
    } catch { /* A vanished panel must never interrupt cleanup. */ }
  }
  /** Even's origin changes on relaunch; native app storage preserves the preceding run. */
  async attach(native: NativeStorage): Promise<void> {
    if (!this.options.enabled) return;
    this.native = native;
    try {
      const prior = parse(await native.getLocalStorage(KEY));
      const combined = [...prior, ...this.rows()];
      const unique = new Map(combined.map(row => [`${row.run}:${row.at}:${row.event}`, row]));
      this.save([...unique.values()].sort((a, b) => a.at - b.at));
      this.nativeReady = true; this.dirty = true;
      await this.persistNative();
    } catch { this.nativeState = 'failed'; this.render(); }
  }
  private async persistNative(): Promise<void> {
    if (!this.nativeReady || !this.native || this.writing) return;
    this.writing = true;
    try {
      while (this.dirty) {
        this.dirty = false; this.nativeState = 'pending'; this.render();
        const raw = JSON.stringify(this.memory);
        try { this.nativeState = await this.native.setLocalStorage(KEY, raw) ? 'saved' : 'failed'; }
        catch { this.nativeState = 'failed'; }
        this.render();
      }
    } finally { this.writing = false; }
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
      this.save([...this.rows(), row]);
      this.options.log(`[exit-check] ${new Date(row.at).toISOString().slice(11, 19)} ${row.run} ${row.event}`);
      this.dirty = true; void this.persistNative(); this.render();
    } catch { /* Diagnostics must never interrupt the app or its stop path. */ }
  }
}
