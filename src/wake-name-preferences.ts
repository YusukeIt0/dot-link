import { validateWakeName } from './wake-name.ts';
interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface NativeStore { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<unknown>; }
export const WAKE_NAME_KEY = 'dot-wake-name-v1';
export interface WakeNameSetting { custom: boolean; name: string; }
const defaults = (): WakeNameSetting => ({ custom: false, name: 'Dot' });
function parse(raw: string | null): WakeNameSetting | undefined {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || typeof value.custom !== 'boolean' || typeof value.name !== 'string') return;
    const checked = validateWakeName(value.name);
    if (!checked.error) return { custom: value.custom, name: checked.name };
  } catch {}
}

/** The name is stored separately; restoring it can never enable the microphone. */
export class WakeNamePreferences {
  value: WakeNameSetting = defaults();
  private revision = 0;
  private native?: NativeStore;
  private storage: () => Store;
  private writes = Promise.resolve(true);
  constructor(storage: () => Store) {
    this.storage = storage;
    try { this.value = parse(storage().getItem(WAKE_NAME_KEY)) ?? defaults(); } catch {}
  }
  get assistantName(): string { return this.value.custom ? this.value.name : 'Dot'; }
  get wakeName(): string { return this.value.custom ? this.value.name : 'dot'; }
  async attach(native: NativeStore): Promise<void> {
    this.native = native;
    if (this.revision > 0) { await this.save(this.value); return; }
    const revision = this.revision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([native.getLocalStorage(WAKE_NAME_KEY), new Promise<string>(resolve => {
        timer = setTimeout(() => resolve(''), 3000);
      })]);
      if (revision !== this.revision) return;
      // An explicit but corrupt native copy must not restore a stale custom name.
      if (raw) this.value = parse(raw) ?? defaults();
      this.writeLocal();
    } catch {} finally { clearTimeout(timer); }
  }
  save(value: WakeNameSetting): Promise<boolean> {
    const checked = validateWakeName(value.name);
    if (checked.error) return Promise.resolve(false);
    this.value = {custom: value.custom, name: checked.name}; this.revision++;
    const saved = this.writeLocal(), native = this.native, raw = JSON.stringify(this.value);
    this.writes = this.writes.then(async () => {
      if (!native) return saved;
      try { return await native.setLocalStorage(WAKE_NAME_KEY, raw) === true; } catch { return false; }
    });
    return this.writes;
  }
  private writeLocal(): boolean {
    try { this.storage().setItem(WAKE_NAME_KEY, JSON.stringify(this.value)); return true; } catch { return false; }
  }
}
