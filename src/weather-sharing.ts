import {SATELLITE_TERMS, WEATHER_TERMS} from './weather-terms.ts';

export interface WeatherStatus {
  weatherProtocol?: number; weatherEpoch?: string | null; weatherEnabled?: boolean; weatherTerms?: string;
  satelliteTerms?: string; satelliteEnabled?: boolean;
}
type NativeStorage = {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
};
type UpgradeOffer = {accept: () => Promise<void>; dismiss: () => void};
type Presentation = {epoch: string; retryAt: number; key?: string; offer?: UpgradeOffer};
const STORAGE_RETRY = 30_000;

async function nativeResult<T>(operation: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<undefined>(resolve => {timer = setTimeout(() => resolve(undefined), 3000);})]);
  } catch { return undefined; }
  finally {if (timer) clearTimeout(timer);}
}

/** Consent belongs to the selected Mac. Status and reconnects never enable a source. */
export class WeatherSharing {
  private value: WeatherStatus = {};
  private origin?: string;
  private pairing?: string;
  private sessionVersion?: number;
  private received = -Infinity;
  private pending?: symbol;
  private failed = false;
  private satelliteFailedFor?: string;
  private awaitingSatelliteStatus = false;
  private native?: NativeStorage;
  private presentation?: Presentation;
  // A visible card and its explicit dismissal do not depend on the lifetime of
  // a WebView. Only opaque disclosure keys can be retried here; never POSTs.
  private readonly shown = new Map<string, number>();
  private options: {
    target: () => string | undefined; api: (input: unknown) => Promise<unknown>; changed: () => void; now?: () => number;
    upgrade?: {pairing: () => string | undefined; sessionVersion: () => number; foreground: () => boolean};
  };
  constructor(options: WeatherSharing['options']) {this.options = options;}
  private sameSession() {
    return this.origin === this.options.target() && this.pairing === this.options.upgrade?.pairing() &&
      this.sessionVersion === this.options.upgrade?.sessionVersion();
  }
  receive(value: WeatherStatus) {
    if (!this.sameSession()) {this.presentation = undefined; this.pending = undefined; this.satelliteFailedFor = undefined;}
    if (this.presentation && (value.weatherEpoch !== this.presentation.epoch || !value.weatherEnabled || value.satelliteEnabled !== false)) this.presentation = undefined;
    this.awaitingSatelliteStatus = false;
    this.value = value; this.origin = this.options.target(); this.received = this.now(); this.failed = false;
    this.pairing = this.options.upgrade?.pairing(); this.sessionVersion = this.options.upgrade?.sessionVersion();
    if (this.satelliteFailedFor !== this.origin || !value.weatherEnabled || value.satelliteEnabled) this.satelliteFailedFor = undefined;
    this.options.changed();
  }
  private now() {return (this.options.now ?? Date.now)();}
  reset() {
    this.value = {}; this.origin = undefined; this.received = -Infinity; this.satelliteFailedFor = undefined;
    this.presentation = undefined; this.pending = undefined; this.awaitingSatelliteStatus = false; this.options.changed();
  }
  status() {
    const connected = !!this.origin && this.sameSession() && this.now() - this.received < 45_000;
    const supported = connected && this.value.weatherProtocol === 1 && typeof this.value.weatherEpoch === 'string' && this.value.weatherTerms === WEATHER_TERMS;
    const satelliteSupported = supported && this.value.satelliteTerms === SATELLITE_TERMS && typeof this.value.satelliteEnabled === 'boolean';
    return {...(connected ? this.value : {}), supported, satelliteSupported, pending: !!this.pending, failed: this.failed,
      satelliteFailed: satelliteSupported && this.satelliteFailedFor === this.origin,
      awaitingSatelliteStatus: this.awaitingSatelliteStatus};
  }

  attachUpgradeStorage(native: NativeStorage) {
    this.native = native; this.options.changed();
  }
  private upgradeEligible() {
    const s = this.status();
    return !!this.pairing && s.satelliteSupported && s.weatherEnabled === true && s.satelliteEnabled === false;
  }
  private persistShown(key: string, native: NativeStorage) {
    const next = this.shown.get(key);
    if (next !== undefined && this.now() < next) return;
    this.shown.set(key, Infinity);
    void nativeResult(native.setLocalStorage(key, 'shown')).then(ok => {
      if (ok !== true) this.shown.set(key, this.now() + STORAGE_RETRY);
    });
  }
  upgradeOffer(): UpgradeOffer | undefined {
    if (!this.native || !this.options.upgrade?.foreground()) return;
    for (const [key, retry] of this.shown) if (retry <= this.now()) this.persistShown(key, this.native);
    if (!this.upgradeEligible() || this.pending || this.awaitingSatelliteStatus) return;
    const presentation = this.presentation ??= {epoch: this.value.weatherEpoch!, retryAt: 0};
    if (presentation.offer && presentation.key) {
      // This synchronous return is the first paint of the foreground card.
      // A process killed during native setup has not consumed its only offer.
      this.persistShown(presentation.key, this.native);
      return presentation.offer;
    }
    if (this.now() >= presentation.retryAt) {
      presentation.retryAt = Infinity;
      void this.prepareOffer(presentation, this.native);
    }
  }
  private async prepareOffer(presentation: Presentation, native: NativeStorage) {
    const current = () => this.presentation === presentation && this.value.weatherEpoch === presentation.epoch && this.upgradeEligible();
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(['weather-offer', SATELLITE_TERMS, this.origin, this.pairing]));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const key = 'dot-weather-' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (!current() || this.shown.has(key)) return;
      const marker = await nativeResult(native.getLocalStorage(key));
      if (marker === undefined) throw Error('Native store unavailable');
      if (marker !== '' || !current()) return;
      // Probe a separate constant key, so a late/hung readiness write cannot
      // consume the offer or overwrite a newer durable dismissal.
      const ready = await nativeResult(native.setLocalStorage('dot-weather-notice-ready', '1'));
      if (ready !== true) throw Error('Native store unavailable');
      if (!current()) return;
      presentation.key = key;
      const validChoice = () => current() && !this.pending && !this.awaitingSatelliteStatus &&
        presentation.offer === offer && !!this.options.upgrade?.foreground();
      const offer: UpgradeOffer = {
        accept: async () => {
          if (!validChoice()) return;
          await this.control(true, true);
        },
        dismiss: () => {
          if (!validChoice()) return;
          presentation.offer = undefined; this.options.changed();
        },
      };
      presentation.offer = offer; this.options.changed();
    } catch {
      // Retry availability only after backoff on a later ordinary render.
      presentation.retryAt = this.now() + STORAGE_RETRY;
    } finally {
      if (this.presentation === presentation && !this.upgradeEligible()) this.presentation = undefined;
    }
  }
  async control(enabled: boolean, includeSatellite = false) {
    const state = this.status(), target = this.options.target();
    if (this.pending || (includeSatellite && this.awaitingSatelliteStatus)) return;
    const presentation = this.presentation;
    if (!state.supported || !target || (includeSatellite && (!enabled || !state.satelliteSupported))) {
      this.failed = true; this.options.changed(); return;
    }
    const request = Symbol();
    const current = () => this.pending === request && this.sameSession();
    this.pending = request; this.failed = false; this.satelliteFailedFor = undefined; this.options.changed();
    try {
      const response = await this.options.api({protocol: 1, epoch: state.weatherEpoch, enabled,
        ...(enabled ? {terms: WEATHER_TERMS} : {}), ...(includeSatellite ? {satellite_terms: SATELLITE_TERMS} : {})}) as WeatherStatus;
      if (current() && (this.value.weatherEpoch === state.weatherEpoch || this.value.weatherEpoch === response.weatherEpoch)) {
        if (includeSatellite && response.weatherEnabled && response.satelliteEnabled !== true) {
          this.satelliteFailedFor = target;
          // This response confirms the attempted upgrade left MET active.
          if (presentation && this.presentation === presentation && response.weatherEpoch) presentation.epoch = response.weatherEpoch;
        }
        this.receive(response);
      }
    } catch {
      if (current()) {
        this.failed = true;
        // An unconfirmed POST may already have succeeded. Wait for a normal
        // status read, then allow only an explicit retry if MET is still alone.
        if (includeSatellite) this.awaitingSatelliteStatus = true;
      }
    }
    finally {if (this.pending === request) this.pending = undefined; this.options.changed();}
  }
}
