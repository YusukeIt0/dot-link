import { apiAddress, parseCredentials, type RelayCredentials } from './relay-connection.ts';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
interface NativeStore { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<boolean>; }
const KEY = 'dot-disconnect-v1';
const identity = (value: RelayCredentials) => `${value.origin}:${value.resumeToken ?? value.token}`;
function decode(raw: string | null): RelayCredentials[] {
  if (!raw || raw === 'null') return [];
  const value = JSON.parse(raw);
  if (value.version !== 1 || !Array.isArray(value.pending)) throw new Error('Invalid disconnect journal');
  const entries: RelayCredentials[] = [];
  for (const entry of value.pending) {
    if (entry && Number.isFinite(entry.expiresAt) && entry.expiresAt <= Date.now()) continue;
    const credentials = parseCredentials(JSON.stringify(entry));
    if (!credentials) throw new Error('Invalid disconnect proof');
    entries.push(credentials);
  }
  return entries;
}
async function bounded<T>(operation: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation.catch(() => fallback), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), 5000); })]); }
  finally { clearTimeout(timer); }
}

/** Separate from active pairing: an ordinary credential save cannot erase an
 * offline disconnect. Entries are capabilities for revocation only, never resume. */
export class DisconnectJournal {
  private entries: RelayCredentials[] = [];
  private native?: NativeStore;
  private loaded = false;
  private writes = Promise.resolve(false);
  private storage: () => Store;
  constructor(storage: () => Store) {
    this.storage = storage;
    try { this.entries = decode(storage().getItem(KEY)); } catch { /* Native restore must still succeed before connecting. */ }
  }
  get pending(): readonly RelayCredentials[] { return this.entries; }
  blocks(credentials: RelayCredentials): boolean { return this.entries.some(entry => identity(entry) === identity(credentials)); }
  async attach(native: NativeStore): Promise<boolean> {
    this.native = native;
    this.loaded = false;
    const raw = await bounded(Promise.resolve().then(() => native.getLocalStorage(KEY)), undefined);
    if (raw === undefined) return false;
    try {
      for (const entry of decode(raw)) if (!this.blocks(entry)) this.entries.push(entry);
      this.loaded = true;
      this.local();
      return true;
    } catch { return false; }
  }
  add(credentials: RelayCredentials): void {
    if (!this.blocks(credentials)) this.entries.push({ ...credentials });
    this.local();
  }
  acknowledge(credentials: RelayCredentials): void {
    this.entries = this.entries.filter(entry => identity(entry) !== identity(credentials));
    this.local();
  }
  private serialized(): string { return JSON.stringify({ version: 1, pending: this.entries }); }
  private local(): void { try { this.storage().setItem(KEY, this.serialized()); } catch {} }
  async persist(): Promise<boolean> {
    this.local();
    if (!this.native || !this.loaded) return false;
    const native = this.native, value = this.serialized();
    // Do not overtake a still-running SDK write after an observation timeout.
    this.writes = this.writes.then(async () => { try { return await native.setLocalStorage(KEY, value) === true; } catch { return false; } });
    return bounded(this.writes, false);
  }
}

interface RetryOptions {
  journal: DisconnectJournal;
  fetch: typeof fetch;
  changed: (state: { pending: number; durable: boolean }) => void;
  durable: () => void;
}
export class DisconnectRetry {
  private stopped = false;
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private controller = new AbortController();
  private options: RetryOptions;
  constructor(options: RetryOptions) { this.options = options; }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.controller.abort(); }
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    clearTimeout(this.timer);
    const operation = this.attempt();
    this.flight = operation;
    void operation.finally(() => {
      this.flight = undefined;
      if (!this.stopped && this.options.journal.pending.length) this.timer = setTimeout(() => { void this.run(); }, 30000);
    });
    return operation;
  }
  private async attempt(): Promise<void> {
    const { journal } = this.options;
    const durable = await journal.persist();
    if (this.stopped) return;
    if (durable) this.options.durable();
    this.options.changed({ pending: journal.pending.length, durable });
    for (const credentials of [...journal.pending]) {
      if (this.stopped) return;
      let complete = credentials.expiresAt <= Date.now();
      if (!complete) {
        try {
          const response = await this.options.fetch(apiAddress('/api/pair/revoke', credentials.origin), {
            method: 'POST', credentials: 'omit', redirect: 'error',
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(credentials.resumeToken ? { resumeToken: credentials.resumeToken } : {}),
            signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
          });
          complete = response.status === 204;
        } catch { /* Retain proof and retry; never recover a data session. */ }
      }
      if (this.stopped) return;
      if (complete) {
        journal.acknowledge(credentials);
        await journal.persist();
        if (this.stopped) return;
      }
    }
    this.options.changed({ pending: journal.pending.length, durable });
  }
}
