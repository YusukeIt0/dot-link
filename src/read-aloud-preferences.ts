type LocalStore = Pick<Storage, 'getItem' | 'setItem'>;
interface NativeStore { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<boolean>; }
const KEY = 'dot-read-aloud-preference-v1';
function parse(raw: string | null): boolean | undefined {
  return raw === 'true' ? true : raw === 'false' ? false : undefined;
}

/** Explicit playback choices survive packaged WebView origin changes. */
export class ReadAloudPreferences {
  value = false;
  private hasLocal = false;
  private revision = 0;
  private native?: NativeStore;
  private writes = Promise.resolve(false);
  private storage: () => LocalStore;
  constructor(storage: () => LocalStore) {
    this.storage = storage;
    try {
      const saved = parse(storage().getItem(KEY));
      this.hasLocal = saved !== undefined; this.value = saved ?? false;
    } catch {}
  }
  async attach(native: NativeStore): Promise<void> {
    this.native = native;
    // A choice made before the bridge arrived still needs native persistence.
    if (this.revision > 0) { await this.queueNative(this.value); return; }
    const revision = this.revision;
    const timedOut = Symbol('native preference timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([native.getLocalStorage(KEY), new Promise<typeof timedOut>(resolve => {
        timer = setTimeout(() => resolve(timedOut), 3000);
      })]);
      if (revision !== this.revision) return;
      // An unread native copy may contain a newer OFF. Never migrate on timeout.
      if (raw === timedOut) { this.value = false; return; }
      const saved = parse(raw);
      if (saved !== undefined) { this.value = saved; this.writeLocal(); }
      else if (this.hasLocal) await this.queueNative(this.value);
    } catch {
      if (revision === this.revision) this.value = false;
    } finally { clearTimeout(timer); }
  }
  save(enabled: boolean): Promise<boolean> {
    this.value = enabled; this.revision++;
    const localSaved = this.writeLocal();
    return this.queueNative(enabled).then(nativeSaved => nativeSaved || localSaved);
  }
  private writeLocal(): boolean {
    try { this.storage().setItem(KEY, String(this.value)); this.hasLocal = true; return true; }
    catch { return false; }
  }
  private queueNative(enabled: boolean): Promise<boolean> {
    const native = this.native;
    this.writes = this.writes.then(async () => {
      if (!native) return false;
      try { return await native.setLocalStorage(KEY, String(enabled)) === true; }
      catch { return false; }
    });
    return this.writes;
  }
}
