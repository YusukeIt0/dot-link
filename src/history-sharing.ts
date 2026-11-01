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
  private now: () => number;
  constructor(privateOptions: {target: () => string | undefined; api: (input: unknown) => Promise<unknown>; changed: () => void; now?: () => number}) {
    this.options = privateOptions; this.now = privateOptions.now ?? Date.now;
  }
  private options: {target: () => string | undefined; api: (input: unknown) => Promise<unknown>; changed: () => void};
  receive(value: HistoryStatus) {
    this.value = value; this.origin = this.options.target(); this.received = this.now(); this.options.changed();
  }
  reset() { this.value = {}; this.origin = undefined; this.received = -Infinity; this.options.changed(); }
  status() {
    const connected = !!this.origin && this.origin === this.options.target() && this.now() - this.received < 45_000;
    const supported = connected && this.value.historyProtocol === 1 && typeof this.value.historyEpoch === 'string';
    return {...(connected ? this.value : {}), connected, supported, pending: this.pending, failed: this.failed};
  }
  upload() {
    const state = this.status();
    if (!state.supported || !state.historyEnabled || state.historySimulation || this.pending) return undefined;
    let timezone: string | undefined;
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    return {protocol: 1, epoch: state.historyEpoch, ...(timezone ? {timezone} : {}), utc_offset_minutes: -new Date(this.now()).getTimezoneOffset()};
  }
  async control(action: 'enable' | 'disable' | 'delete' | 'simulate' | 'finish_simulation', scenario?: string) {
    const state = this.status(), target = this.options.target();
    if (this.pending || !state.supported || !target) return;
    this.pending = true; this.failed = false; this.options.changed();
    try {
      const response = await this.options.api({protocol: 1, epoch: state.historyEpoch, action, ...(scenario ? {scenario} : {})});
      if (target !== this.options.target()) return;
      this.receive(response as HistoryStatus);
    } catch { if (target === this.options.target()) this.failed = true; }
    finally { this.pending = false; this.options.changed(); }
  }
}
