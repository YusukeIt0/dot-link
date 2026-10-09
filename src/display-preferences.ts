import { DEFAULT_DISPLAY_PREFERENCES, DISPLAY_PREFERENCES_KEY, parseDisplayPreferences, type DisplayPreferences } from './display-standby.ts';

interface LocalStore { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface NativeStore { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<unknown>; }

/** Local writes are immediate; native writes stay ordered, including restore races. */
export class DisplayPreferenceStore {
  value: DisplayPreferences;
  private hasLocal = false;
  private revision = 0;
  private native?: NativeStore;
  private writes = Promise.resolve(true);
  private storage: () => LocalStore;
  constructor(storage: () => LocalStore) {
    this.storage = storage;
    let saved: DisplayPreferences | undefined;
    try { saved = parseDisplayPreferences(storage().getItem(DISPLAY_PREFERENCES_KEY)); } catch {}
    this.hasLocal = !!saved;
    this.value = saved ?? { ...DEFAULT_DISPLAY_PREFERENCES };
  }
  async attach(native: NativeStore): Promise<boolean> {
    this.native = native;
    const version = this.revision;
    if (!this.hasLocal) {
      try {
        const saved = parseDisplayPreferences(await native.getLocalStorage(DISPLAY_PREFERENCES_KEY));
        if (saved && version === this.revision) { this.value = saved; this.writeLocal(); return true; }
      } catch {}
    }
    return false;
  }
  save(value: DisplayPreferences): Promise<boolean> {
    if (!parseDisplayPreferences(JSON.stringify(value))) throw new Error('Invalid display settings');
    this.value = { ...value }; this.revision++;
    const localSaved = this.writeLocal();
    const native = this.native;
    const serialized = JSON.stringify(this.value);
    this.writes = this.writes.then(async () => {
      if (!native) return localSaved;
      try { const result = await native.setLocalStorage(DISPLAY_PREFERENCES_KEY, serialized); return result !== false || localSaved; }
      catch { return localSaved; }
    });
    return this.writes;
  }
  private writeLocal(): boolean {
    try { this.storage().setItem(DISPLAY_PREFERENCES_KEY, JSON.stringify(this.value)); this.hasLocal = true; return true; }
    catch { return false; }
  }
}
