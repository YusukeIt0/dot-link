import { hkdfSync } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { activationRecordSchema, type ActivationRecord } from '../sharing-activation.ts';
import { HealthVault } from './vault.ts';
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
  private suspended = false;
  // At most one supported write awaits a repaired receipt file. Network sends
  // still require a successful write of the attempt under the vault lock.
  private uncommitted?: Binding;

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
      this.cached = this.withKey(healthKey, key => schema.parse(this.file.read(key)));
    }
    return this.cached.bindings.find(entry => entry.snapshot === snapshot);
  }

  current(healthKey: Buffer, vault: HealthVault) {
    const snapshot = vault.fingerprint;
    if (!snapshot || !vault.matches(snapshot)) throw new Error('Polar activation snapshot unavailable');
    const bound = this.binding(healthKey, snapshot) ?? (this.uncommitted?.snapshot === snapshot ? this.uncommitted : undefined);
    if (this.suspended && !bound) throw new Error('Polar activation receipt unavailable');
    return {decision: bound?.decision ?? snapshot, record: bound?.record};
  }

  private write(healthKey: Buffer, bindings: Binding[]) {
    const next = {version: 1 as const, bindings};
    this.withKey(healthKey, key => this.file.write(key, next));
    this.cached = next;
    this.uncommitted = undefined;
    this.suspended = false;
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
    let next: Binding | undefined;
    try {
      const prior = this.uncommitted?.snapshot === previous ? this.uncommitted : this.binding(healthKey, previous);
      if (prior) {
        const record = subscribed ? {...prior.record, delivery: 'complete' as const} : prior.record;
        next = {...prior, snapshot: pending, record};
        this.write(healthKey, [prior, next]);
      }
    } catch {
      // The primary vault must still accept observations and the owner's controls.
      // Never deliver another setup request from an uncertain local receipt.
      this.uncommitted = next;
      this.suspended = true;
    }
  }

  discard() {
    try { if (this.file.exists()) this.file.remove(); }
    catch { /* The ciphertext is bound to the retired decision's snapshot. */ }
    this.cached = undefined;
    this.uncommitted = undefined;
    this.suspended = false;
  }
}
