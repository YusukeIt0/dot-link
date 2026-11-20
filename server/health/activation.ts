import { hkdfSync } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { activationRecordSchema, type ActivationRecord } from '../sharing-activation.ts';
import { HealthVault, InvalidHealthVaultPayload } from './vault.ts';
import { lockHealthControl } from './control-lock.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({snapshot: digest, decision: digest, record: activationRecordSchema}).strict();
const schema = z.object({version: z.literal(1), bindings: z.array(bindingSchema).min(1).max(2)}).strict();
type Binding = z.infer<typeof bindingSchema>;

/** The released v1 vault has a strict schema. Keep the relay's receipt encrypted
 * separately and recognize it only for exact snapshots of that vault. */
export class PolarActivationJournal {
  private readonly directory: string;
  private readonly file: HealthVault;
  private cached?: z.infer<typeof schema>;
  // Only committed writes by this process can extend this same-choice link.
  // Keep its endpoints and reread the actual receipt when the lock is available.
  private deferred?: {origin: string; snapshot: string; completed: boolean; hadReceipt: boolean};

  constructor(vaultPath: string) {
    this.directory = vaultPath + '.history';
    this.file = new HealthVault(join(this.directory, 'activation.enc'));
  }

  private withKey<T>(healthKey: Buffer, run: (key: Buffer) => T): T {
    const key = Buffer.from(hkdfSync('sha256', healthKey, Buffer.alloc(0), 'dot-link:polar:activation:v1', 32));
    try { return run(key); } finally { key.fill(0); }
  }

  private binding(healthKey: Buffer, snapshot: string) {
    if (!this.file.exists()) { this.cached = undefined; return; }
    if (!this.cached || !this.file.fingerprint || !this.file.matches(this.file.fingerprint)) {
      // A legacy reset can replace the health key and vault while leaving this
      // file behind. A usable primary vault still carries the owner's choice.
      // save() rereads under the writer lock before atomically replacing it.
      this.cached = undefined;
      try {
        const parsed = this.withKey(healthKey, key => schema.safeParse(this.file.read(key)));
        if (!parsed.success) return;
        this.cached = parsed.data;
      } catch (error) {
        if (error instanceof InvalidHealthVaultPayload) return;
        throw error;
      }
    }
    return this.cached.bindings.find(entry => entry.snapshot === snapshot);
  }

  private projection(healthKey: Buffer, snapshot: string) {
    const bound = this.binding(healthKey, snapshot);
    const gap = this.deferred;
    if (bound || gap?.snapshot !== snapshot) return bound;
    const origin = this.binding(healthKey, gap.origin);
    if (!origin) {
      if (gap.hadReceipt) throw new Error('Polar activation receipt unavailable');
      return;
    }
    return {...origin, snapshot, record: gap.completed ? {...origin.record, delivery: 'complete' as const} : origin.record};
  }

  current(healthKey: Buffer, vault: HealthVault) {
    const snapshot = vault.fingerprint;
    if (!snapshot || !vault.matches(snapshot)) throw new Error('Polar activation snapshot unavailable');
    const bound = this.projection(healthKey, snapshot);
    return {decision: bound?.decision ?? snapshot, record: bound?.record};
  }

  load(healthKey: Buffer, vault: HealthVault) {
    if (!this.deferred || this.deferred.snapshot !== vault.fingerprint) return this.current(healthKey, vault).record;
    // Opportunistic repair never waits on another writer in the relay event loop.
    const release = lockHealthControl(this.directory, true, 0);
    try {
      const current = this.current(healthKey, vault);
      if (current.record) this.write(healthKey, [{snapshot: vault.fingerprint!, decision: current.decision, record: current.record}]);
      else this.deferred = undefined;
      return current.record;
    } finally { release?.(); }
  }

  private write(healthKey: Buffer, bindings: Binding[]) {
    const next = {version: 1 as const, bindings};
    this.withKey(healthKey, key => this.file.write(key, next));
    this.cached = next;
    this.deferred = undefined;
  }

  save(healthKey: Buffer, vault: HealthVault, record: ActivationRecord, previous?: ActivationRecord) {
    const release = lockHealthControl(this.directory, true);
    try {
      const current = this.current(healthKey, vault);
      if (!isDeepStrictEqual(current.record, previous)) throw new Error('Polar activation receipt changed');
      this.write(healthKey, [{snapshot: vault.fingerprint!, decision: current.decision, record}]);
    } finally { release?.(); }
  }

  /** Called under the same writer lock as the v1 rename. A crash leaves either
   * the old snapshot and its receipt or the new snapshot and its receipt.
   * Writes from earlier versions create a nonce that is absent from both. */
  checkpoint(healthKey: Buffer, previous: string, pending: string, subscribed: boolean) {
    try {
      const prior = this.projection(healthKey, previous);
      if (prior) {
        const record = subscribed ? {...prior.record, delivery: 'complete' as const} : prior.record;
        this.write(healthKey, [prior, {...prior, snapshot: pending, record}]);
      }
      return true;
    } catch { return false; }
  }

  /** The lock was busy or a checkpoint could not be written. Never advance a
   * disk receipt without its lock. Record the link only after the v1 commit. */
  defer(previous: string, snapshot: string, subscribed: boolean) {
    const gap = this.deferred?.snapshot === previous ? this.deferred : undefined;
    this.deferred = {
      origin: gap?.origin ?? previous, snapshot, completed: subscribed || !!gap?.completed,
      hadReceipt: gap?.hadReceipt ?? !!this.cached?.bindings.some(entry => entry.snapshot === previous),
    };
  }

  forget() {
    this.cached = undefined;
    this.deferred = undefined;
  }

  discard() {
    try { if (this.file.exists()) this.file.remove(); }
    catch { /* The ciphertext is bound to the retired decision's snapshot. */ }
    this.forget();
  }
}
