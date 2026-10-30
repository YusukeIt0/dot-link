import { AppLocationAccuracy, type AppLocation, type AppLocationOptions } from '@evenrealities/even_hub_sdk';
import { phoneLocation, freshLocation, type LocationFix } from './location-fix.ts';

interface NativeLocation {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
  startAppLocationUpdates(options?: AppLocationOptions): Promise<boolean>;
  stopAppLocationUpdates(): Promise<boolean>;
  getAppLocation(options?: AppLocationOptions): Promise<AppLocation | null>;
  onAppLocationChanged(callback: (fix: AppLocation) => void): () => void;
}
interface Preferences { enabled: boolean; mobility: boolean; origin?: string; stops: { sharing_id: string; origin: string }[]; }
export interface LocationStatus {
  enabled: boolean;
  mobility: boolean;
  mobilitySupported?: boolean;
  state: 'off' | 'starting' | 'waiting' | 'sharing' | 'stale' | 'unavailable' | 'offline' | 'stopping';
  measuredAt?: string; receivedAt?: string; accuracy?: number; dotSubscribed?: boolean;
  receivedCount?: number; dotReadAt?: string; announcementCount?: number; saved: boolean;
}
export interface LocationRelayStatus {
  mobilitySupported?: boolean;
  locationSubscribed?: boolean; locationSharing?: boolean; locationFresh?: boolean;
  locationReceivedAt?: string | null; locationMeasuredAt?: string | null; locationAccuracy?: number | null;
  locationReceivedCount?: number; locationDotReadAt?: string | null; locationAnnouncementCount?: number;
}
const KEY = 'dot-location-sharing-v1';
const empty = (): Preferences => ({ enabled: false, mobility:false, stops: [] });
function parse(raw: string | null): Preferences | undefined {
  if (!raw) return;
  try {
    const p = JSON.parse(raw);
    if (typeof p.enabled !== 'boolean' || (p.origin !== undefined && typeof p.origin !== 'string') || !Array.isArray(p.stops)) return;
    if (p.stops.length > 20 || p.stops.some((s: any) => typeof s.sharing_id !== 'string' || !/^[a-f0-9-]{36}$/.test(s.sharing_id) || typeof s.origin !== 'string')) return;
    return { enabled: p.enabled, mobility:p.mobility===true, ...(p.origin ? {origin: p.origin} : {}), stops: p.stops };
  } catch { return; }
}

/** Keep acquiring in a hidden WebView; explicit app exit/off stops sharing. No location is persisted. */
export class LocationSharing {
  private preferences: Preferences;
  private native?: NativeLocation;
  private removeListener?: () => void;
  private ready = false;
  private disposed = false;
  private abandoned = false;
  private revision = 0;
  private nativeChain = Promise.resolve();
  private nativeStarted = false;
  private nativeFailed = false;
  private capability?: {origin: string | undefined; supported: boolean};
  private session?: { id: string; origin: string; mobility: boolean; enabled: boolean; sequence: number; uploadedAt?: string };
  private latest?: LocationFix;
  private working = false;
  private stopping?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private relayStatus: LocationRelayStatus = {};
  private state: LocationStatus['state'] = 'off';
  private saved = true;
  private writes = Promise.resolve();
  private storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  private target: () => string | undefined;
  private api: (path: string, body: unknown) => Promise<unknown>;
  private changed: () => void;
  private now: () => number;
  constructor(options: { storage: () => Pick<Storage, 'getItem' | 'setItem'>; target: () => string | undefined;
    api: (path: string, body: unknown) => Promise<unknown>; changed: () => void; now?: () => number; automatic?: boolean }) {
    this.storage = options.storage; this.target = options.target; this.api = options.api; this.changed = options.changed; this.now = options.now ?? Date.now;
    try { this.preferences = parse(this.storage().getItem(KEY)) ?? empty(); } catch { this.preferences = empty(); }
    // Wait for native storage before automatically restoring consent on a new WebView origin.
    if (options.automatic !== false) this.timer = setInterval(() => { void this.pump(); }, 15_000);
  }
  status(): LocationStatus {
    let state = this.state;
    if (!this.preferences.enabled && this.nativeStarted) state = 'stopping';
    if (this.preferences.enabled && state === 'sharing' && (!freshLocation(this.latest, this.now()) || this.relayStatus.locationFresh === false)) state = 'stale';
    return { enabled: this.preferences.enabled, mobility:this.preferences.mobility, mobilitySupported:this.capability?.origin===this.target()?this.capability?.supported:undefined, state, saved: this.saved,
      measuredAt: this.relayStatus.locationMeasuredAt ?? undefined, receivedAt: this.relayStatus.locationReceivedAt ?? undefined,
      accuracy: this.relayStatus.locationAccuracy ?? undefined, dotSubscribed: this.relayStatus.locationSubscribed,
      receivedCount: this.relayStatus.locationReceivedCount, dotReadAt: this.relayStatus.locationDotReadAt ?? undefined,
      announcementCount: this.relayStatus.locationAnnouncementCount };
  }
  acceptsAnnouncement(message: {location_sharing_id?: string; location_expires_at?: string}): boolean {
    if (!message.location_sharing_id) return true;
    return !this.disposed && this.preferences.enabled && this.session?.id === message.location_sharing_id &&
      typeof message.location_expires_at === 'string' && Date.parse(message.location_expires_at) > this.now();
  }
  async attach(native: NativeLocation): Promise<void> {
    if (this.disposed) return;
    this.native = native;
    const revision = this.revision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([native.getLocalStorage(KEY), new Promise<string>(resolve => { timer = setTimeout(() => resolve(''), 3000); })]);
      if (revision === this.revision) this.preferences = parse(raw) ?? this.preferences;
    } catch {} finally { if (timer) clearTimeout(timer); }
    if (this.disposed) return;
    this.ready = true;
    if (typeof native.onAppLocationChanged !== 'function' || typeof native.startAppLocationUpdates !== 'function' || typeof native.stopAppLocationUpdates !== 'function' || typeof native.getAppLocation !== 'function') {
      this.nativeFailed = true; this.state = this.preferences.enabled ? 'unavailable' : 'off'; this.changed(); return;
    }
    this.removeListener = native.onAppLocationChanged(raw => {
      if (!this.preferences.enabled || this.disposed) return;
      const fix = phoneLocation(raw, this.now());
      if (fix && (!this.latest || Date.parse(fix.measured_at) >= Date.parse(this.latest.measured_at))) this.latest = fix;
    });
    this.changed(); await this.pump();
  }
  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.revision++;
    if (enabled && !this.target()) { this.state = 'offline'; this.changed(); return; }
    if (this.preferences.enabled === enabled && enabled) return;
    this.preferences.enabled = enabled;
    if (enabled) { if(this.preferences.origin!==this.target())this.preferences.mobility=false; this.preferences.origin = this.target(); this.nativeFailed = false; this.state = 'starting'; }
    else { this.stopCurrent(); this.state = this.preferences.stops.length ? 'stopping' : 'off'; }
    this.persist(); this.changed(); this.syncNative();
    if (!enabled) void this.flushStops();
    void this.pump();
  }
  setMobilityEnabled(enabled:boolean):void {
    if(this.disposed||this.preferences.mobility===enabled)return;
    if(enabled&&(!this.preferences.enabled||this.preferences.origin!==this.target()||!this.supportsMobility()))return;
    this.revision++;this.preferences.mobility=enabled;
    // A new session makes old delayed enables unable to restore prior consent.
    this.stopCurrent();this.persist();this.changed();
    void this.flushStops().then(()=>this.pump());
  }
  private supportsMobility(){return this.capability?.origin===this.target()&&this.capability?.supported===true;}
  receive(status: LocationRelayStatus) {
    if (this.disposed) return;
    this.capability={origin:this.target(),supported:status.mobilitySupported===true};
    if(this.session&&this.session.mobility!==(this.preferences.mobility&&this.supportsMobility())){
      this.revision++;this.stopCurrent();this.state=this.preferences.enabled?'starting':'off';
      void this.flushStops().then(()=>this.pump());
      this.changed();return;
    }
    this.relayStatus = status;
    if (this.session?.enabled && status.locationSharing === false) this.session.enabled = false;
    this.changed();
  }
  private persist() {
    if (this.abandoned) return;
    const raw = JSON.stringify(this.preferences);
    let local = false;
    try { this.storage().setItem(KEY, raw); local = true; } catch {}
    const native = this.native;
    this.writes = this.writes.then(async () => {
      if (this.abandoned) return;
      let saved = false;
      try { saved = !!native && await native.setLocalStorage(KEY, raw); } catch {}
      if (this.abandoned) return;
      this.saved = saved || local; this.changed();
    });
  }
  private stopCurrent() {
    const session = this.session;
    if (session && !this.preferences.stops.some(s => s.sharing_id === session.id)) {
      this.preferences.stops.push({ sharing_id: session.id, origin: session.origin });
      this.preferences.stops = this.preferences.stops.slice(-20);
    }
    this.session = undefined; this.latest = undefined; this.relayStatus = {};
  }
  private syncNative() {
    this.nativeChain = this.nativeChain.then(async () => {
      const native = this.native;
      if (!native || !this.ready || this.abandoned) return;
      const enabled = this.preferences.enabled && !this.disposed && !!this.target() && this.preferences.origin === this.target();
      if (enabled && !this.nativeStarted && !this.nativeFailed) {
        this.state = 'starting'; this.changed();
        try {
          const ok = await native.startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 15_000, distanceFilter: 25 });
          if (this.abandoned) return;
          if (!ok) throw new Error('Location unavailable');
          this.nativeStarted = true;
        } catch { this.nativeFailed = true; this.state = 'unavailable'; }
      }
      if (this.abandoned) return;
      // An off click may have arrived while native permission/start was awaiting.
      if (this.nativeStarted && (!this.preferences.enabled || this.disposed || this.preferences.origin !== this.target())) {
        try { if (await native.stopAppLocationUpdates()) this.nativeStarted = false; } catch {}
      }
      this.changed();
    });
  }
  private async flushStops(): Promise<void> {
    if (this.abandoned) return;
    if (this.stopping) return this.stopping;
    const operation = (async () => {
      const target = this.target();
      for (const stop of [...this.preferences.stops]) {
        if (this.abandoned) return;
        if (!target || stop.origin !== target) continue;
        try {
          await this.api('/api/location/control', { sharing_id: stop.sharing_id, enabled: false });
          if (this.abandoned) return;
          this.preferences.stops = this.preferences.stops.filter(s => s.sharing_id !== stop.sharing_id); this.persist();
        } catch { if (!this.preferences.enabled) this.state = 'stopping'; return; }
      }
      if (!this.preferences.enabled) this.state = 'off';
      this.changed();
    })();
    this.stopping = operation;
    try { await operation; } finally { if (this.stopping === operation) this.stopping = undefined; }
  }
  async pump(): Promise<void> {
    if (this.working || !this.ready || this.abandoned) return;
    this.working = true;
    const revision=this.revision;
    try {
      const target = this.target();
      // Consent is scoped to the user's chosen Mac; connecting another Mac doesn't inherit it.
      if (this.preferences.enabled && target && this.preferences.origin !== target) {
        this.preferences.enabled = false; this.preferences.mobility=false; this.stopCurrent(); this.persist();
      }
      this.syncNative();
      // Revocations do not wait behind a native permission prompt.
      await this.flushStops();
      if (this.abandoned) return;
      if (this.preferences.stops.some(s => s.origin === target)) { this.state = this.preferences.enabled ? 'offline' : 'stopping'; return; }
      if (!this.preferences.enabled || this.disposed) { this.state = this.preferences.stops.some(s => s.origin === target) ? 'stopping' : 'off'; return; }
      if (!target) { this.state = 'offline'; return; }
      await this.nativeChain;
      if (!this.preferences.enabled || this.disposed || this.target() !== target) return;
      if (this.nativeFailed || !this.nativeStarted) { this.state = 'unavailable'; return; }
      const session = this.session ??= { id: crypto.randomUUID(), origin: target, mobility:this.preferences.mobility&&this.supportsMobility(), enabled: false, sequence: 0 };
      if (!this.latest || this.now() - Date.parse(this.latest.measured_at) > 30_000) {
        // Stationary phones may suppress pushes. An occasional fresh fix keeps current/stale honest.
        const raw = await this.native!.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: 8000 }).catch(() => null);
        if (this.session !== session || !this.preferences.enabled || this.disposed) return;
        const fix = phoneLocation(raw, this.now());
        if (fix && (!this.latest || Date.parse(fix.measured_at) >= Date.parse(this.latest.measured_at))) this.latest = fix;
      }
      if (this.session !== session || !this.preferences.enabled || this.disposed || this.target() !== target) return;
      const fix = freshLocation(this.latest, this.now()) ? this.latest : undefined;
      // A surviving WebView must not keep a sharing lease alive with empty heartbeats or
      // repeated cached measurements after the native location source has stopped.
      // New native measurements resume sharing; timers alone cannot renew it.
      if (!fix || (session.uploadedAt && Date.parse(fix.measured_at) <= Date.parse(session.uploadedAt))) {
        this.state = fix && this.relayStatus.locationSharing !== false ? 'sharing' : this.latest ? 'stale' : 'waiting';
        return;
      }
      if (!session.enabled) {
        await this.api('/api/location/control', { sharing_id: session.id, enabled: true, ...(session.mobility ? {mobility_enabled:true} : {}) });
        if (this.session !== session || !this.preferences.enabled || this.disposed) return;
        session.enabled = true;
      }
      const status = await this.api('/api/location/update', { sharing_id: session.id, sequence: ++session.sequence, fix });
      if (this.session !== session || !this.preferences.enabled || this.disposed) return;
      session.uploadedAt = fix.measured_at;
      this.receive(status as LocationRelayStatus);
      if(this.session!==session)return;
      this.state = fix ? 'sharing' : this.latest ? 'stale' : 'waiting';
    } catch { if (this.preferences.enabled) { this.state = 'offline'; if (this.session) this.session.enabled = false; } }
    finally { this.working = false; if (!this.abandoned) {this.changed();if(revision!==this.revision&&!this.disposed)queueMicrotask(()=>{void this.pump();});} }
  }
  /** Ownership handoff cancels only local work, never shared consent/native state. */
  abandon(): void {
    this.abandoned = true; this.disposed = true; this.revision++;
    if (this.timer) clearInterval(this.timer);
    this.removeListener?.(); this.removeListener = undefined;
    this.session = undefined; this.latest = undefined;
  }
  /** Explicit glasses-app exit ends the live session; the saved preference resumes on next launch. */
  async stop(): Promise<void> {
    if (this.abandoned) return;
    this.disposed = true; this.revision++;
    if (this.timer) clearInterval(this.timer);
    this.removeListener?.(); this.stopCurrent(); this.persist(); this.syncNative();
    // Best effort; the relay lease also expires if the WebView has already stopped.
    const target = this.target();
    for (const stop of [...this.preferences.stops]) {
      if (stop.origin !== target) continue;
      if (this.abandoned) return;
      try { await this.api('/api/location/control', {sharing_id: stop.sharing_id, enabled: false});
        if (this.abandoned) return;
        this.preferences.stops = this.preferences.stops.filter(s => s.sharing_id !== stop.sharing_id); this.persist(); } catch {}
    }
  }
}
