export const historySources = ['location', 'polar', 'weather', 'mobility'] as const;
export const historyPeriods = ['7d', '1m', '6m', '1y'] as const;
export type HistorySource = typeof historySources[number];
export type HistoryPeriod = typeof historyPeriods[number];
export type HistoryChange = {action: 'set'; source: HistorySource; enabled: boolean} |
  {action: 'delete'; source: HistorySource} | {action: 'period'; period: HistoryPeriod};
interface HistorySettings {
  protocol: 1;
  epoch: string;
  terms: 'selected-factor-history-v1';
  period: HistoryPeriod;
  sources: Partial<Record<HistorySource, boolean>>;
  polarEpoch?: string;
  polarAvailable?: boolean;
}
function readSettings(value: unknown): HistorySettings {
  const s = value as Partial<HistorySettings> | null;
  if (!s || s.protocol !== 1 || s.terms !== 'selected-factor-history-v1' || typeof s.epoch !== 'string' ||
      !s.period || !historyPeriods.includes(s.period) || !s.sources || typeof s.sources !== 'object' ||
      historySources.some(source => source in s.sources! && typeof s.sources![source] !== 'boolean') ||
      (s.polarEpoch !== undefined && typeof s.polarEpoch !== 'string')) throw new Error('Invalid history settings');
  return s as HistorySettings;
}

/** Mac-owned choices. Opening the panel reads the target's settings, and a
 * previous pairing's result is ignored even if its request finishes later. */
export class FactorHistorySettings {
  private target?: string;
  private supported = false;
  private sequence = 0;
  private pending = false;
  private failed = false;
  private settings?: HistorySettings;
  private options: {request: (command?: object) => Promise<unknown>; changed: () => void};
  constructor(options: FactorHistorySettings['options']) { this.options = options; }
  receive(target: string | undefined, supported: boolean) {
    if (target === this.target && supported === this.supported) return;
    this.sequence++;
    this.target = target;
    this.supported = supported && !!target;
    this.pending = this.failed = false;
    this.settings = undefined;
    this.options.changed();
  }
  status() { return {settings: this.settings, supported: this.supported, pending: this.pending, failed: this.failed}; }
  async refresh() { return this.request(); }
  async change(change: HistoryChange) {
    const state = this.settings;
    if (!state || this.pending || !this.supported) return;
    const source = 'source' in change ? change.source : undefined;
    if (source && (typeof state.sources[source] !== 'boolean' || (source === 'polar' && !state.polarEpoch))) return;
    return this.request({protocol: 1, epoch: state.epoch, terms: state.terms, change,
      ...(source === 'polar' ? {polarEpoch: state.polarEpoch} : {})});
  }
  private async request(command?: object) {
    if (!this.supported || this.pending) return;
    const sequence = ++this.sequence;
    this.pending = true;
    this.failed = false;
    this.options.changed();
    try {
      const response = readSettings(await this.options.request(command));
      if (sequence === this.sequence) this.settings = response;
    } catch {
      if (sequence !== this.sequence) return;
      this.failed = true;
      // A lost acknowledgement can follow a committed change. Read the Mac's
      // answer again before displaying a switch or accepting another change.
      this.settings = undefined;
      if (command) try {
        const current = readSettings(await this.options.request());
        if (sequence === this.sequence) this.settings = current;
      } catch { /* Reopening the panel retries an unavailable Mac. */ }
    } finally {
      if (sequence === this.sequence) { this.pending = false; this.options.changed(); }
    }
  }
}
