import { apiAddress, type RelayCredentials, type RelaySettings } from './relay-connection.ts';
import type { PairingInvite } from './relay-origin.ts';
interface Options {
  settings: RelaySettings;
  legacyToken: string;
  appOrigin: string;
  fetch: typeof fetch;
  rejected: (reason: 'expired' | 'invalid') => void;
  persistenceFailed: () => void;
}

/** Owns the active credentials and request lifetime; the app owns reset/UI policy. */
export class RelaySession {
  private options: Options;
  private saved: RelayCredentials | undefined;
  private credential: string;
  private controller = new AbortController();
  private epoch = 0;
  private stopped = false;
  private resumeFlight: Promise<void> | undefined;
  constructor(options: Options) {
    this.options = options; this.saved = options.settings.read();
    this.credential = this.saved?.token ?? options.legacyToken;
  }
  get credentials(): RelayCredentials | undefined { return this.saved; }
  get token(): string { return this.credential; }
  get version(): number { return this.epoch; }
  isCurrent(version: number): boolean { return !this.stopped && version === this.epoch; }
  restart(): void {
    this.controller.abort(); this.controller = new AbortController(); this.epoch++;
    this.resumeFlight = undefined;
  }
  stop(): void { this.stopped = true; this.epoch++; this.controller.abort(); }
  use(saved: RelayCredentials | undefined, legacyToken = ''): void {
    this.saved = saved; this.credential = saved?.token ?? legacyToken;
  }
  save(saved: RelayCredentials): boolean {
    const retained = this.options.settings.save(saved); this.use(saved); return retained;
  }
  forget(): void { this.use(undefined); this.options.settings.forget(); }
  private check(version: number): void { if (!this.isCurrent(version)) throw new Error('Connection changed'); }
  async ensureOrigin(force = false): Promise<void> {
    const saved = this.saved;
    if (!saved?.resumeToken || (!force && saved.appOrigin === this.options.appOrigin)) return;
    if (this.resumeFlight) return this.resumeFlight;
    const version = this.epoch;
    const attempt = (async () => {
      const response = await this.options.fetch(apiAddress('/api/pair/resume', saved.origin), {
        method: 'POST', credentials: 'omit', redirect: 'error', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({resumeToken: saved.resumeToken}),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
      });
      this.check(version);
      if (response.status === 401) { this.options.rejected('expired'); throw new Error('Recovery rejected'); }
      if (!response.ok) throw new Error('Recovery unavailable');
      const renewed: RelayCredentials = {...await response.json(), origin: saved.origin, appOrigin: this.options.appOrigin};
      this.check(version); this.save(renewed);
      void this.options.settings.nativeSaved().then(ok => { if (!ok && this.isCurrent(version)) this.options.persistenceFailed(); });
    })();
    this.resumeFlight = attempt;
    try { await attempt; } finally { if (this.resumeFlight === attempt) this.resumeFlight = undefined; }
  }
  async request(path: string, method = 'GET', body?: string | Uint8Array, trace?: string, requestSignal?: AbortSignal, recovered = false): Promise<Response> {
    const version = this.epoch;
    await this.ensureOrigin(); this.check(version);
    const response = await this.options.fetch(apiAddress(path, this.saved?.origin), {
      method, credentials: 'omit', redirect: 'error', headers: {Authorization: `Bearer ${this.token}`,
        ...(trace ? {'X-G2-Trace-ID': trace} : {}),
        ...(body ? {'Content-Type': typeof body === 'string' ? 'application/json' : 'audio/wav'} : {})},
      body: body instanceof Uint8Array ? new Blob([new Uint8Array(body).buffer], {type: 'audio/wav'}) : body,
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(path === '/api/transcribe' ? 100000 : 25000), ...(requestSignal ? [requestSignal] : [])]),
    });
    this.check(version);
    if (response.status === 401 && this.saved?.resumeToken && !recovered) {
      await this.ensureOrigin(true);
      return this.request(path, method, body, trace, requestSignal, true);
    }
    if (response.status === 401) this.options.rejected('invalid');
    return response;
  }
  async updates<T>(revision: string | undefined, signal: AbortSignal): Promise<T> {
    const version = this.epoch;
    await this.ensureOrigin(); this.check(version);
    if (signal.aborted) throw new Error('Connection changed');
    const response = await this.options.fetch(apiAddress('/api/updates', this.saved?.origin), {
      credentials: 'omit', redirect: 'error', headers: {Authorization: `Bearer ${this.token}`, ...(revision ? {'X-G2-Revision': revision} : {})},
      signal: AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(25000)]),
    });
    this.check(version);
    if (!signal.aborted && response.status === 401) {
      if (this.saved?.resumeToken) await this.ensureOrigin(true);
      else this.options.rejected('invalid');
    }
    if (!response.ok) throw new Error('Update connection failed');
    const result = await response.json(); this.check(version); return result;
  }
  async pair(invite: PairingInvite): Promise<RelayCredentials> {
    const version = this.epoch;
    const response = await this.options.fetch(apiAddress('/api/pair', invite.origin), {
      method: 'POST', redirect: 'error', credentials: 'omit', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({code: invite.code}), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error('Pairing failed');
    const result = {...await response.json(), origin: invite.origin, appOrigin: this.options.appOrigin};
    this.check(version); return result;
  }
  async location(path: string, body: unknown): Promise<unknown> {
    // Stop uses a captured destination and its own deadline: it must survive
    // app exit or credential removal, unlike ordinary session requests.
    const stopping = path === '/api/location/control' && (body as {enabled?: boolean}).enabled === false;
    if (!stopping) await this.ensureOrigin();
    const target = this.saved?.origin, credential = this.token;
    if (!credential) throw new Error('Pairing required');
    const response = await this.options.fetch(apiAddress(path, target), {method: 'POST', credentials: 'omit', redirect: 'error',
      headers: {Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error('Location sharing unavailable');
    return response.json();
  }
}
