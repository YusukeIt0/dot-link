const KEY = 'g2-device-token';
const valid = (value: string | null): value is string => /^[A-Za-z0-9_-]{43}$/.test(value ?? '');
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Storage may be disabled in a WebView. Keep the active session usable anyway. */
export class Pairing {
  private persistent: () => StorageLike;
  private session: () => StorageLike;
  constructor(persistent: () => StorageLike, session: () => StorageLike) { this.persistent = persistent; this.session = session; }
  read(): string {
    for (const storage of [this.persistent, this.session]) {
      try { const value = storage().getItem(KEY); if (valid(value)) { this.save(value); return value; } } catch {}
    }
    return '';
  }
  save(value: string): boolean {
    if (!valid(value)) return false;
    let retained = false;
    try { this.persistent().setItem(KEY, value); retained = true; } catch {}
    try { this.session().setItem(KEY, value); } catch {}
    return retained;
  }
  forget(): void {
    for (const storage of [this.persistent, this.session]) { try { storage().removeItem(KEY); } catch {} }
  }
}
