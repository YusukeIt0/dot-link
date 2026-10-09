import { appOrigin, relayOrigin } from './relay-origin.ts';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface RelayCredentials { origin: string; token: string; expiresAt: number; resumeToken?: string; appOrigin?: string; }
const KEY = 'dot-relay-v1';
const NATIVE_KEY = 'dot-relay-native-v1';
interface NativeStore { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<boolean>; }
function parseCredentials(raw: string | null): RelayCredentials | undefined {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) return;
    if (value.resumeToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(value.resumeToken)) return;
    return { origin: relayOrigin(value.origin), token: value.token, expiresAt: value.expiresAt,
      ...(value.resumeToken ? {resumeToken: value.resumeToken} : {}), ...(value.appOrigin ? {appOrigin: appOrigin(value.appOrigin)} : {}) };
  } catch { return; }
}
/** One atomic credential record. Native app storage survives a WebView origin
 * change; localStorage alone is partitioned by the iOS package's random port.
 * A native tombstone prevents stale WebView caches from undoing explicit logout.
 */
export class RelaySettings {
  private storage: () => StorageLike;
  private native?: NativeStore;
  private revision = 0;
  private writes = Promise.resolve(false);
  constructor(storage: () => StorageLike) { this.storage = storage; }
  read(): RelayCredentials | undefined {
    try { return parseCredentials(this.storage().getItem(KEY)); } catch { return; }
  }
  async attach(native: NativeStore): Promise<RelayCredentials | undefined> {
    this.native = native;
    const revision = this.revision;
    let raw: string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      raw = await Promise.race([native.getLocalStorage(NATIVE_KEY), new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('Storage timeout')), 5000); })]);
    } catch { return this.read(); } finally { if (timer) clearTimeout(timer); }
    if (revision !== this.revision) return this.read();
    if (raw === 'null') { try { this.storage().removeItem(KEY); } catch {} return; }
    const saved = parseCredentials(raw);
    if (saved) { this.writeLocal(saved); return saved; }
    const local = this.read();
    if (local) this.queueNative(JSON.stringify(local));
    return local;
  }
  save(value: RelayCredentials): boolean {
    const data = parseCredentials(JSON.stringify(value));
    if (!data) throw new Error('Invalid pairing response');
    this.revision++;
    const retained = this.writeLocal(data);
    this.queueNative(JSON.stringify(data));
    return retained;
  }
  private writeLocal(data: RelayCredentials): boolean {
    try { this.storage().setItem(KEY, JSON.stringify(data)); return true; } catch { return false; }
  }
  private queueNative(value: string): void {
    const native = this.native;
    if (!native) return;
    this.writes = this.writes.then(async () => { try { return await native.setLocalStorage(NATIVE_KEY, value) === true; } catch { return false; } });
  }
  async nativeSaved(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.writes, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  forget(): void {
    this.revision++;
    try { this.storage().removeItem(KEY); } catch {}
    this.queueNative('null');
  }
}

export function apiAddress(path: string, origin?: string): string {
  if (!['/api/status', '/api/messages', '/api/updates', '/api/transcribe', '/api/utterances', '/api/timings', '/api/pair', '/api/pair/resume', '/api/pair/revoke'].includes(path)) throw new Error('Unknown API route');
  return origin ? `${relayOrigin(origin)}${path}` : path;
}

/** A delivery timeout is not evidence of failure. Keep its id across relaunch.
 * Only a digest is persisted; the user's words stay in memory or bridge history.
 */
export class PendingUtterance {
  private storage: () => StorageLike;
  private namespace: string;
  private current?: { id: string; digest: string };
  constructor(storage: () => StorageLike, namespace: string) { this.storage = storage; this.namespace = `dot-pending:${namespace}`; }
  async prepare(text: string, suggestedId: string = crypto.randomUUID()): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const digest = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    let saved = this.current;
    try { saved ??= JSON.parse(this.storage().getItem(this.namespace) ?? 'null'); } catch {}
    const id = saved?.digest === digest && /^[0-9a-f-]{36}$/.test(saved.id) ? saved.id : suggestedId;
    this.current = {id, digest};
    try { this.storage().setItem(this.namespace, JSON.stringify(this.current)); } catch {}
    return id;
  }
  clear(): void { this.current = undefined; try { this.storage().removeItem(this.namespace); } catch {} }
}
