import { apiAddress, type RelayCredentials, type RelaySettings } from './relay-connection.ts';
import type { PairingInvite } from './relay-origin.ts';
import { RUNTIME_RECOVERY_PROTOCOL, RUNTIME_SUPERSEDED, runtimeGeneration, type RuntimeRecoveryRequest } from './runtime-recovery.ts';
type Ownership = { stage: 'unknown' | 'legacy' } | { stage: 'claim'; expectedGeneration: number } | { stage: 'owned'; generation: number };
interface Options {
  settings: RelaySettings;
  legacyToken: string;
  appOrigin: string;
  fetch: typeof fetch;
  rejected: (reason: 'expired' | 'invalid') => void;
  persistenceFailed: () => void;
  superseded?: () => void;
  runtimeId?: string;
}

/** Owns the active credentials and request lifetime; the app owns reset/UI policy. */
export class RelaySession {
  private options: Options;
  private saved: RelayCredentials | undefined;
  private credential: string;
  private controller = new AbortController();
  private epoch = 0;
  private stopped = false;
  private ownership: Ownership = { stage: 'unknown' };
  private runtimeId: string;
  private superseded = false;
  private retirement = new AbortController();
  private resumeFlight: Promise<void> | undefined;
  constructor(options: Options) {
    this.runtimeId = options.runtimeId ?? crypto.randomUUID();
    this.options = options; this.saved = options.settings.read();
    this.credential = this.saved?.token ?? options.legacyToken;
  }
  get isSuperseded(): boolean { return this.superseded; }
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
    if (saved?.origin !== this.saved?.origin || saved?.resumeToken !== this.saved?.resumeToken) this.ownership = { stage: 'unknown' };
    this.saved = saved; this.credential = saved?.token ?? legacyToken;
  }
  save(saved: RelayCredentials): boolean {
    const retained = this.options.settings.save(saved); this.use(saved); return retained;
  }
  forget(): void { this.use(undefined); this.options.settings.forget(); }
  private check(version: number): void { if (!this.isCurrent(version)) throw new Error('Connection changed'); }
  private async recover(saved: RelayCredentials, version: number, runtime?: RuntimeRecoveryRequest): Promise<Response> {
    this.check(version);
    const response = await this.options.fetch(apiAddress('/api/pair/resume', saved.origin), {
      method: 'POST', credentials: 'omit', redirect: 'error', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({resumeToken: saved.resumeToken, ...(runtime ? {runtime} : {})}),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
    });
    this.check(version);
    if (response.status === 401) { this.options.rejected('expired'); throw new Error('Recovery rejected'); }
    if (response.status === 409) {
      const failure = await response.json().catch(() => undefined); this.check(version);
      if (failure?.code === RUNTIME_SUPERSEDED) {
        this.superseded = true; this.retirement.abort(); this.stop();
        this.options.superseded?.();
        throw new Error('Runtime superseded');
      }
    }
    return response;
  }
  async ensureOrigin(force = false): Promise<void> {
    const version = this.epoch; this.check(version);
    const saved = this.saved;
    if (!saved?.resumeToken) return;
    if (this.resumeFlight) return this.resumeFlight;
    if (this.ownership.stage !== 'unknown' && this.ownership.stage !== 'claim' && !force && saved.appOrigin === this.options.appOrigin) return;
    const attempt = (async () => {
      if (this.ownership.stage === 'unknown') {
        const response = await this.recover(saved, version, {action: 'inspect'});
        const result = await response.json().catch(() => undefined); this.check(version);
        // Only this old-server response to inspect negotiates legacy support.
        if (response.status === 400 && result?.error === 'Invalid pairing request' && Object.keys(result).length === 1) {
          this.ownership = {stage: 'legacy'};
        } else {
          if (!response.ok || result?.protocol !== RUNTIME_RECOVERY_PROTOCOL || !runtimeGeneration(result.generation)) throw new Error('Recovery unavailable');
          // Retain the CAS even if the claim reply is lost or the loop restarts.
          this.ownership = {stage: 'claim', expectedGeneration: result.generation};
        }
      }
      const owner = this.ownership;
      if (owner.stage === 'legacy' && !force && saved.appOrigin === this.options.appOrigin) return;
      const runtime: RuntimeRecoveryRequest | undefined = owner.stage === 'claim'
        ? {action: 'claim', id: this.runtimeId, expectedGeneration: owner.expectedGeneration}
        : owner.stage === 'owned' ? {action: 'renew', id: this.runtimeId, generation: owner.generation} : undefined;
      const response = await this.recover(saved, version, runtime);
      if (!response.ok) throw new Error('Recovery unavailable');
      const result = await response.json(); this.check(version);
      if (runtime && (result.protocol !== RUNTIME_RECOVERY_PROTOCOL ||
          result.generation !== (owner.stage === 'claim' ? owner.expectedGeneration + 1 : owner.stage === 'owned' ? owner.generation : -1) ||
          result.resumeToken !== saved.resumeToken)) throw new Error('Invalid recovery response');
      const renewed: RelayCredentials = {...result, origin: saved.origin, appOrigin: this.options.appOrigin};
      this.save(renewed);
      if (runtime) this.ownership = {stage: 'owned', generation: result.generation};
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
  async updates<T>(revision: string | undefined, signal: AbortSignal, recovered = false): Promise<T> {
    const version = this.epoch;
    await this.ensureOrigin(); this.check(version);
    if (signal.aborted) throw new Error('Connection changed');
    const response = await this.options.fetch(apiAddress('/api/updates', this.saved?.origin), {
      credentials: 'omit', redirect: 'error', headers: {Authorization: `Bearer ${this.token}`, ...(revision ? {'X-G2-Revision': revision} : {})},
      signal: AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(25000)]),
    });
    this.check(version);
    if (!signal.aborted && response.status === 401) {
      if (this.saved?.resumeToken && !recovered) {
        await this.ensureOrigin(true); this.check(version);
        return this.updates<T>(revision, signal, true);
      }
      this.options.rejected('invalid');
    }
    if (!response.ok) throw new Error('Update connection failed');
    const result = await response.json(); this.check(version); return result;
  }
  async pair(invite: PairingInvite): Promise<RelayCredentials> {
    const version = this.epoch; this.check(version);
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
    if (this.superseded) throw new Error('Runtime superseded');
    if (!stopping) {
      const version = this.epoch;
      const response = await this.request(path, 'POST', JSON.stringify(body));
      if (!response.ok) throw new Error('Location sharing unavailable');
      const result = await response.json(); this.check(version); return result;
    }
    const target = this.saved?.origin, credential = this.token;
    if (!credential) throw new Error('Pairing required');
    const response = await this.options.fetch(apiAddress(path, target), {method: 'POST', credentials: 'omit', redirect: 'error',
      headers: {Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.any([this.retirement.signal, AbortSignal.timeout(12000)])});
    if (!response.ok) throw new Error('Location sharing unavailable');
    return response.json();
  }
}
