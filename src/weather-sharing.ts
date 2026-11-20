import {SATELLITE_TERMS, WEATHER_TERMS} from './weather-terms.ts';

export interface WeatherStatus {
  weatherProtocol?: number; weatherEpoch?: string | null; weatherEnabled?: boolean; weatherTerms?: string;
  satelliteTerms?: string; satelliteEnabled?: boolean;
}
/** Consent belongs to the selected Mac. Status and reconnects never enable a source. */
export class WeatherSharing {
  private value: WeatherStatus = {};
  private origin?: string;
  private received = -Infinity;
  private pending = false;
  private failed = false;
  private satelliteFailedFor?: string;
  private options: {target: () => string | undefined; api: (input: unknown) => Promise<unknown>; changed: () => void; now?: () => number};
  constructor(options: WeatherSharing['options']) {this.options = options;}
  receive(value: WeatherStatus) {
    this.value = value; this.origin = this.options.target(); this.received = this.now(); this.failed = false;
    if (this.satelliteFailedFor !== this.origin || !value.weatherEnabled || value.satelliteEnabled) this.satelliteFailedFor = undefined;
    this.options.changed();
  }
  private now() {return (this.options.now ?? Date.now)();}
  reset() {this.value = {}; this.origin = undefined; this.received = -Infinity; this.satelliteFailedFor = undefined; this.options.changed();}
  status() {
    const connected = !!this.origin && this.origin === this.options.target() && this.now() - this.received < 45_000;
    const supported = connected && this.value.weatherProtocol === 1 && typeof this.value.weatherEpoch === 'string' && this.value.weatherTerms === WEATHER_TERMS;
    const satelliteSupported = supported && this.value.satelliteTerms === SATELLITE_TERMS && typeof this.value.satelliteEnabled === 'boolean';
    return {...(connected ? this.value : {}), supported, satelliteSupported, pending: this.pending, failed: this.failed,
      satelliteFailed: satelliteSupported && this.satelliteFailedFor === this.origin};
  }
  async control(enabled: boolean, includeSatellite = false) {
    const state = this.status(), target = this.options.target();
    if (this.pending) return;
    if (!state.supported || !target || (includeSatellite && (!enabled || !state.satelliteSupported))) {
      this.failed = true; this.options.changed(); return;
    }
    this.pending = true; this.failed = false; this.satelliteFailedFor = undefined; this.options.changed();
    try {
      const result = await this.options.api({protocol: 1, epoch: state.weatherEpoch, enabled,
        ...(enabled ? {terms: WEATHER_TERMS} : {}), ...(includeSatellite ? {satellite_terms: SATELLITE_TERMS} : {})});
      if (target === this.options.target()) {
        const response = result as WeatherStatus;
        if (includeSatellite && response.weatherEnabled && response.satelliteEnabled !== true) this.satelliteFailedFor = target;
        this.receive(response);
      }
    } catch {if (target === this.options.target()) this.failed = true;}
    finally {this.pending = false; this.options.changed();}
  }
}
