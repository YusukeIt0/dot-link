interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface NativeStore { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<unknown>; }
function parse(raw: string | null): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/** Missing or invalid settings never turn on microphone listening. */
class BooleanPreference {
  value = false;
  private hasLocal = false;
  private revision = 0;
  private native?: NativeStore;
  private storage: () => Store;
  private writes = Promise.resolve(true);
  private key: string;
  private saferValue: boolean;
  constructor(storage: () => Store, key: string, saferValue: boolean) {
    this.storage = storage; this.key = key; this.saferValue = saferValue;
    try {
      const value = parse(storage().getItem(this.key));
      this.hasLocal = value !== undefined; this.value = value ?? false;
    } catch {}
  }
  async attach(native: NativeStore): Promise<void> {
    this.native = native;
    // A choice made in this session outranks every restored copy.
    if (this.revision > 0) { await this.save(this.value); return; }
    const revision = this.revision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([native.getLocalStorage(this.key), new Promise<string>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Preference restore timed out')), 3000);
      })]);
      if (revision !== this.revision) return;
      const restored = parse(raw);
      // Packaged WebViews can revisit an old origin with a stale ON value.
      // Conflicting copies choose the setting that prevents accidental recording.
      if (restored === this.saferValue || !this.hasLocal) this.value = restored ?? false;
      this.writeLocal();
    } catch {
      // An unavailable native store is not evidence of an unset preference.
      // With no local copy, protect input for this session without persisting
      // a guessed value. A later launch can retry; a fresh user choice wins.
      if (revision === this.revision && !this.hasLocal) this.value = this.saferValue;
    } finally { clearTimeout(timer); }
  }
  save(enabled: boolean): Promise<boolean> {
    this.value = enabled; this.revision++;
    const saved = this.writeLocal(), native = this.native, raw = String(enabled);
    this.writes = this.writes.then(async () => {
      if (!native) return saved;
      try { return await native.setLocalStorage(this.key, raw) === true; }
      catch { return false; }
    });
    return this.writes;
  }
  private writeLocal(): boolean {
    try { this.storage().setItem(this.key, String(this.value)); this.hasLocal = true; return true; }
    catch { return false; }
  }
}

/** Independent choices: disabling holds must never enable wake listening. */
export class OperationPreferences {
  private wake: BooleanPreference;
  private hold: BooleanPreference;
  constructor(storage: () => Store) {
    this.wake = new BooleanPreference(storage, 'dot-operation-preferences-v1', false);
    this.hold = new BooleanPreference(storage, 'dot-disable-hold-recording-v1', true);
  }
  get wakeWord(): boolean { return this.wake.value; }
  get disableHoldRecording(): boolean { return this.hold.value; }
  async attach(native: NativeStore): Promise<void> {
    await Promise.all([this.wake.attach(native), this.hold.attach(native)]);
  }
  save(enabled: boolean): Promise<boolean> { return this.wake.save(enabled); }
  saveDisableHoldRecording(disabled: boolean): Promise<boolean> { return this.hold.save(disabled); }
}
