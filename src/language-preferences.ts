export type LanguagePreference = 'auto' | 'ja' | 'en';
type LocalStore = Pick<Storage, 'getItem' | 'setItem'>;
interface NativeStore { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<boolean>; }
const KEY = 'dot-language';
const NATIVE_KEY = 'dot-language-preference-v1';
function parse(raw: string | null): LanguagePreference | undefined {
  return raw === 'auto' || raw === 'ja' || raw === 'en' ? raw : undefined;
}

/** Keep explicit choices across WebView origins; first use follows the host locale. */
export class LanguagePreferences {
  value: LanguagePreference = 'auto';
  private storage: () => LocalStore;
  private native?: NativeStore;
  private revision = 0;
  private writes = Promise.resolve(true);
  constructor(storage: () => LocalStore) {
    this.storage = storage;
    try { this.value = parse(storage().getItem(KEY)) ?? 'auto'; } catch {}
  }
  async attach(native: NativeStore): Promise<void> {
    this.native = native;
    const revision = this.revision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([native.getLocalStorage(NATIVE_KEY), new Promise<string>(resolve => {
        timer = setTimeout(() => resolve(''), 3000);
      })]);
      if (revision !== this.revision) return;
      const saved = parse(raw);
      if (saved) { this.value = saved; this.writeLocal(); }
      else if (this.value !== 'auto') void this.queueNative(this.value);
    } catch {} finally { if (timer) clearTimeout(timer); }
  }
  save(value: LanguagePreference): Promise<boolean> {
    if (!parse(value)) throw new Error('Invalid language preference');
    this.value = value; this.revision++;
    const localSaved = this.writeLocal();
    return this.queueNative(value).then(nativeSaved => nativeSaved || localSaved);
  }
  private writeLocal(): boolean {
    try { this.storage().setItem(KEY, this.value); return true; } catch { return false; }
  }
  private queueNative(value: LanguagePreference): Promise<boolean> {
    const native = this.native;
    this.writes = this.writes.then(async () => {
      if (!native) return false;
      try { return await native.setLocalStorage(NATIVE_KEY, value) === true; } catch { return false; }
    });
    return this.writes;
  }
}
