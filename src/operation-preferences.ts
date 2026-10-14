interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface NativeStore { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<unknown>; }
const KEY = 'dot-operation-preferences-v1';
function parse(raw: string | null): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/** Missing or invalid settings never turn on microphone listening. */
export class OperationPreferences {
  wakeWord = false;
  private hasLocal = false;
  private revision = 0;
  private native?: NativeStore;
  private storage: () => Store;
  private writes = Promise.resolve(true);
  constructor(storage: () => Store) {
    this.storage = storage;
    try {
      const value = parse(storage().getItem(KEY));
      this.hasLocal = value !== undefined; this.wakeWord = value ?? false;
    } catch {}
  }
  async attach(native: NativeStore): Promise<void> {
    this.native = native;
    if (this.hasLocal) return;
    const revision = this.revision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([native.getLocalStorage(KEY), new Promise<string>(resolve => {
        timer = setTimeout(() => resolve(''), 3000);
      })]);
      if (revision !== this.revision) return;
      this.wakeWord = parse(raw) ?? false; this.writeLocal();
    } catch {} finally { clearTimeout(timer); }
  }
  save(enabled: boolean): Promise<boolean> {
    this.wakeWord = enabled; this.revision++;
    const saved = this.writeLocal(), native = this.native, raw = String(enabled);
    this.writes = this.writes.then(async () => {
      if (!native) return saved;
      try { return await native.setLocalStorage(KEY, raw) === true || saved; }
      catch { return saved; }
    });
    return this.writes;
  }
  private writeLocal(): boolean {
    try { this.storage().setItem(KEY, String(this.wakeWord)); this.hasLocal = true; return true; }
    catch { return false; }
  }
}
