export interface WeatherStatus {
  weatherProtocol?: number; weatherEpoch?: string | null; weatherEnabled?: boolean; weatherTerms?: string;
}
/** Server-owned consent; never carry it across Mac targets or enable it from a tool. */
export class WeatherSharing {
  private value: WeatherStatus = {};
  private origin?: string;
  private received = -Infinity;
  private pending = false;
  private failed = false;
  private options: {target: () => string | undefined; api: (input: unknown) => Promise<unknown>; changed: () => void; now?: () => number};
  constructor(options: WeatherSharing['options']) {this.options = options;}
  receive(value: WeatherStatus) {this.value = value; this.origin = this.options.target(); this.received = this.now(); this.options.changed();}
  private now() {return (this.options.now ?? Date.now)();}
  reset() {this.value = {}; this.origin = undefined; this.received = -Infinity; this.options.changed();}
  status() {
    const connected = !!this.origin && this.origin === this.options.target() && this.now() - this.received < 45_000;
    return {...(connected ? this.value : {}), supported: connected && this.value.weatherProtocol === 1 &&
      typeof this.value.weatherEpoch === 'string' && this.value.weatherTerms === 'met-2026-11-05', pending:this.pending, failed:this.failed};
  }
  async control(enabled: boolean) {
    const state = this.status(), target = this.options.target();
    if (this.pending) return;
    if (!state.supported || !target) {this.failed = true; this.options.changed(); return;}
    this.pending = true; this.failed = false; this.options.changed();
    try {
      const result = await this.options.api({protocol:1, epoch:state.weatherEpoch, enabled, ...(enabled ? {terms:state.weatherTerms} : {})});
      if (target === this.options.target()) this.receive(result as WeatherStatus);
    } catch {if (target === this.options.target()) this.failed = true;}
    finally {this.pending = false; this.options.changed();}
  }
}
