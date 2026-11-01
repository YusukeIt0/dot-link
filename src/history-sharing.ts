export interface HistoryStatus {
  historyProtocol?: number; historyEpoch?: string | null; historyEnabled?: boolean; historyCount?: number;
  historySimulation?: string | null; historyReference?: string | null; historyBeta?: boolean;
}

/** Consent is authoritative on the selected Mac; never migrate the live-location preference. */
export class HistorySharing {
  private value: HistoryStatus = {};
  private origin?: string;
  private received = -Infinity;
  private pending = false;
  private failed = false;
  private pausedOrigin?: string;
  private now: () => number;
  constructor(privateOptions: {target: () => string | undefined; api: (input: unknown) => Promise<unknown>; changed: () => void; now?: () => number}) {
    this.options = privateOptions; this.now = privateOptions.now ?? Date.now;
  }
  private options: {target: () => string | undefined; api: (input: unknown) => Promise<unknown>; changed: () => void};
  receive(value: HistoryStatus) {
    this.value = value; this.origin = this.options.target(); this.received = this.now(); this.options.changed();
  }
  receiveUpload(value: unknown, origin: string | undefined) {
    if (!origin || origin !== this.options.target() || !value || typeof value !== 'object' || !('historyProtocol' in value)) return;
    this.receive(value as HistoryStatus);
  }
  reset() { this.value = {}; this.origin = undefined; this.received = -Infinity; this.options.changed(); }
  status() {
    const connected = !!this.origin && this.origin === this.options.target() && this.now() - this.received < 45_000;
    const supported = connected && this.value.historyProtocol === 1 && typeof this.value.historyEpoch === 'string';
    return {...(connected ? this.value : {}), connected, supported, pending: this.pending, failed: this.failed};
  }
  upload() {
    // Sparse/background fixes can outlive the UI freshness window. The Mac
    // validates the remembered epoch and consent before saving each fix.
    const state = this.value;
    if (!this.origin || this.origin !== this.options.target() || this.pausedOrigin === this.origin || state.historyProtocol !== 1 || typeof state.historyEpoch !== 'string'
      || !state.historyEnabled || state.historySimulation || this.pending) return undefined;
    let timezone: string | undefined;
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    return {protocol: 1, epoch: state.historyEpoch, ...(timezone ? {timezone} : {}), utc_offset_minutes: -new Date(this.now()).getTimezoneOffset()};
  }
  async control(action: 'enable' | 'disable' | 'delete' | 'simulate' | 'finish_simulation', scenario?: string) {
    const state = this.status(), target = this.options.target();
    if (this.pending) { this.options.changed(); return; }
    const stopping = action === 'disable' || action === 'delete';
    if (stopping && target) this.pausedOrigin = target;
    // Stop/delete may use the remembered epoch; the Mac remains authoritative.
    // Even when remote acknowledgement fails, the phone stops contributing fixes.
    const known = !!target && this.origin === target && this.value.historyProtocol === 1 && typeof this.value.historyEpoch === 'string';
    if (!target || !known || (!stopping && !state.supported)) {
      this.failed = true; this.options.changed(); return;
    }
    this.pending = true; this.failed = false; this.options.changed();
    try {
      const response = await this.options.api({protocol: 1, epoch: this.value.historyEpoch, action, ...(scenario ? {scenario} : {})});
      if (target !== this.options.target()) return;
      this.receive(response as HistoryStatus);
      if (action === 'enable' && this.value.historyEnabled === true) this.pausedOrigin = undefined;
    } catch { if (target === this.options.target()) this.failed = true; }
    finally { this.pending = false; this.options.changed(); }
  }
}
