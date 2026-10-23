import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appOrigin, relayOrigin, type PairingInvite } from '../src/relay-origin.ts';
import { pairingGeneration, currentPairingGeneration } from './pairing-generation.ts';
import { runtimeGeneration, runtimeId, runtimeRecoveryRequest, type RuntimeRecoveryRequest } from '../src/runtime-recovery.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const valid = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const fileName = /^[a-f0-9]{64}\.json$/;
const INVITE_LIFETIME = 120000;
const packagedSource = (origin: string): boolean => {
  try { return appOrigin(origin).startsWith('http://127.0.0.1:'); } catch { return false; }
};
const SESSION_LIFETIME = 90 * 24 * 60 * 60 * 1000;

interface RuntimeOwner { id: string; generation: number; origin: string; nonce: string; }
interface RecoveryRecord { revoked?: boolean; currentSession: string; expiresAt: number; generation?: string; runtimeOwner?: RuntimeOwner; }
interface RecoveryCredentials { token: string; expiresAt: number; resumeToken: string; }
export type RuntimeRecoveryResult =
  | { kind: 'inspected'; generation: number }
  | { kind: 'resumed'; generation: number; credentials: RecoveryCredentials }
  | { kind: 'superseded' }
  | { kind: 'invalid' };

/** Credentials never reach the Dot MCP. Only hashes are retained on disk.
 * Each invitation/session has a separate file; CLI revocation cannot overwrite
 * another newly paired session. Synchronous consume prevents concurrent reuse.
 */
export class PairingAuthority {
  private directory: string;
  private clock: () => number;
  constructor(directory: string, clock = () => Date.now()) {
    this.directory = directory; this.clock = clock;
    for (const sub of ['', 'invitations', 'sessions', 'recoveries']) {
      const path = join(directory, sub); mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
    }
  }
  private path(kind: 'invitations' | 'sessions' | 'recoveries', secret: string): string { return join(this.directory, kind, `${digest(secret)}.json`); }
  private recovery(secret: string): RecoveryRecord | undefined {
    if (!valid(secret)) return;
    try {
      const record: RecoveryRecord = JSON.parse(readFileSync(this.path('recoveries', secret), 'utf8'));
      if (record.revoked || !currentPairingGeneration(record, pairingGeneration(this.directory)) ||
        !Number.isFinite(record.expiresAt) || record.expiresAt <= this.clock() || !fileName.test(`${record.currentSession}.json`)) return;
      const owner = record.runtimeOwner;
      if (owner !== undefined && (!owner || !runtimeId(owner.id) || !runtimeGeneration(owner.generation) ||
        owner.generation === 0 || !packagedSource(owner.origin) || !/^[a-f0-9]{64}$/.test(owner.nonce))) return;
      return record;
    } catch { return; }
  }

  /** Once adopted, old recovery callers must not take ownership back. */
  managedRuntime(secret: string): boolean { return !!this.recovery(secret)?.runtimeOwner; }

  /** Startup acquisition uses compare-and-swap; recovery can only renew its owner.
   * A lost response is retried with the original claim, never a newer generation.
   * The nonce is not a credential: deriving a session also requires the secret.
   */
  recoverRuntime(secret: string, origin: string, input: RuntimeRecoveryRequest): RuntimeRecoveryResult {
    const request = runtimeRecoveryRequest(input);
    const record = this.recovery(secret);
    if (!request || !record || !packagedSource(origin)) return { kind: 'invalid' };
    const owner = record.runtimeOwner;
    const current = owner?.generation ?? 0;
    if (request.action === 'inspect') return { kind: 'inspected', generation: current };
    if (request.action === 'renew') {
      if (!owner || owner.id !== request.id || owner.origin !== origin || owner.generation !== request.generation) return { kind: 'superseded' };
      return this.runtimeCredentials(secret, record, owner);
    }
    if (owner?.id === request.id && owner.origin === origin && request.expectedGeneration === current - 1) {
      return this.runtimeCredentials(secret, record, owner);
    }
    if (request.expectedGeneration !== current || owner?.id === request.id || !runtimeGeneration(current + 1)) return { kind: 'superseded' };
    const next: RuntimeOwner = { id: request.id, origin, generation: current + 1, nonce: randomBytes(32).toString('hex') };
    const token = this.runtimeToken(secret, record, next);
    const sessionPath = this.path('sessions', token);
    writeFileSync(sessionPath, JSON.stringify(this.runtimeSession(secret, record, next)), { mode: 0o600, flag: 'wx' });
    const recoveryPath = this.path('recoveries', secret), temporary = `${recoveryPath}.next`;
    try {
      writeFileSync(temporary, JSON.stringify({ ...record, currentSession: digest(token), runtimeOwner: next }), { mode: 0o600 });
      renameSync(temporary, recoveryPath);
    } catch (error) { try { unlinkSync(sessionPath); } catch {} throw error; }
    try { unlinkSync(join(this.directory, 'sessions', `${record.currentSession}.json`)); } catch {}
    return { kind: 'resumed', generation: next.generation, credentials: { token, expiresAt: record.expiresAt, resumeToken: secret } };
  }
  private runtimeToken(secret: string, record: RecoveryRecord, owner: RuntimeOwner): string {
    return createHmac('sha256', secret).update(JSON.stringify([
      'dot-link-runtime-v1', owner.id, owner.generation, owner.origin, owner.nonce, record.expiresAt, record.generation ?? 'initial',
    ])).digest('base64url');
  }
  private runtimeSession(secret: string, record: RecoveryRecord, owner: RuntimeOwner) {
    return { origin: owner.origin, expiresAt: record.expiresAt, recoveryHash: digest(secret), generation: record.generation ?? 'initial' };
  }
  private runtimeCredentials(secret: string, record: RecoveryRecord, owner: RuntimeOwner): RuntimeRecoveryResult {
    const token = this.runtimeToken(secret, record, owner);
    if (digest(token) !== record.currentSession) return { kind: 'invalid' };
    const path = this.path('sessions', token), expected = JSON.stringify(this.runtimeSession(secret, record, owner));
    // Recover a lost session file without rotating ownership or its credential.
    try { if (readFileSync(path, 'utf8') === expected) return { kind: 'resumed', generation: owner.generation, credentials: { token, expiresAt: record.expiresAt, resumeToken: secret } }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = `${path}.next`;
    writeFileSync(temporary, expected, { mode: 0o600 }); renameSync(temporary, path);
    return { kind: 'resumed', generation: owner.generation, credentials: { token, expiresAt: record.expiresAt, resumeToken: secret } };
  }
  private prune(kind: 'invitations' | 'sessions' | 'recoveries'): number {
    let active = 0;
    const generation = pairingGeneration(this.directory);
    for (const name of readdirSync(join(this.directory, kind))) {
      if (!fileName.test(name)) continue;
      const path = join(this.directory, kind, name);
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (!currentPairingGeneration(data, generation) || !Number.isFinite(data.expiresAt) || data.expiresAt <= this.clock()) unlinkSync(path);
        else if (kind !== 'sessions' || this.sessionActive(data, name.slice(0, -5))) active++;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return active;
  }
  issue(origin: string, allowedAppOrigin?: string): PairingInvite {
    const generation = pairingGeneration(this.directory);
    origin = relayOrigin(origin);
    if (allowedAppOrigin !== undefined) allowedAppOrigin = appOrigin(allowedAppOrigin);
    if (this.prune('invitations') >= 5) throw new Error('Too many active pairing invitations');
    const code = randomBytes(32).toString('base64url');
    const expiresAt = this.clock() + INVITE_LIFETIME;
    writeFileSync(this.path('invitations', code), JSON.stringify({ expiresAt, origin: allowedAppOrigin, generation }), { mode: 0o600, flag: 'wx' });
    return { version: 1, origin, code, expiresAt };
  }
  exchange(code: string, origin: string): { token: string; expiresAt: number; resumeToken?: string } | undefined {
    if (!valid(code)) return;
    let invitation: { expiresAt: number; origin?: string; generation?: string };
    try { invitation = JSON.parse(readFileSync(this.path('invitations', code), 'utf8')); } catch { return; }
    if (!currentPairingGeneration(invitation, pairingGeneration(this.directory))) return;
    const generation = invitation.generation ?? 'initial';
    if (invitation.expiresAt <= this.clock() || !Number.isFinite(invitation.expiresAt)) return;
    if (invitation.origin === undefined ? !packagedSource(origin) : invitation.origin !== origin) return;
    this.prune('recoveries');
    if (this.prune('sessions') >= 16) throw new Error('Revoke an old device before pairing another');
    // Consumed before generating a token. A lost response requires a fresh QR.
    try { unlinkSync(this.path('invitations', code)); } catch { return; }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.clock() + SESSION_LIFETIME;
    // Only packaged applications receive a separate update-recovery capability.
    // It cannot access data; sessions still bind to one exact source port.
    const resumeToken = packagedSource(origin) ? randomBytes(32).toString('base64url') : undefined;
    const recoveryHash = resumeToken ? digest(resumeToken) : undefined;
    writeFileSync(this.path('sessions', token), JSON.stringify({ origin, expiresAt, recoveryHash, generation }), { mode: 0o600, flag: 'wx' });
    if (resumeToken) writeFileSync(this.path('recoveries', resumeToken), JSON.stringify({ currentSession: digest(token), expiresAt, generation }), { mode: 0o600, flag: 'wx' });
    return { token, expiresAt, ...(resumeToken ? { resumeToken } : {}) };
  }
  private sessionActive(session: { revoked?: boolean; expiresAt: number; recoveryHash?: string; generation?: string }, hash: string): boolean {
    const generation = pairingGeneration(this.directory);
    if (session.revoked || !currentPairingGeneration(session, generation) || !Number.isFinite(session.expiresAt) || session.expiresAt <= this.clock()) return false;
    if (session.recoveryHash) {
      if (!/^[a-f0-9]{64}$/.test(session.recoveryHash)) return false;
      try {
        const recovery = JSON.parse(readFileSync(join(this.directory, 'recoveries', `${session.recoveryHash}.json`), 'utf8'));
        return !recovery.revoked && currentPairingGeneration(recovery, generation) && recovery.currentSession === hash && recovery.expiresAt === session.expiresAt;
      } catch { return false; }
    }
    return true;
  }
  authorized(token: string, origin: string): boolean {
    if (!valid(token)) return false;
    try {
      const session = JSON.parse(readFileSync(this.path('sessions', token), 'utf8'));
      return session.origin === origin && this.sessionActive(session, digest(token));
    } catch { return false; }
  }
  private markRevoked(path: string, record: object): void {
    const temporary = `${path}.revoke-next`;
    try {
      writeFileSync(temporary, JSON.stringify({ ...record, revoked: true }), { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
  }
  /** Keep the hashed receipt until expiry. A lost response can be retried without
   * recovering a session, and no partial deletion can restore authority. */
  revoke(token: string, origin: string): boolean {
    if (!valid(token)) return false;
    try {
      const session = JSON.parse(readFileSync(this.path('sessions', token), 'utf8'));
      if (session.origin !== origin) return false;
      if (session.recoveryHash) {
        if (!/^[a-f0-9]{64}$/.test(session.recoveryHash)) return false;
        const path = join(this.directory, 'recoveries', `${session.recoveryHash}.json`);
        let record;
        try { record = JSON.parse(readFileSync(path, 'utf8')); }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
        // A stale session is not a revocation capability for its newer owner.
        if (record.currentSession !== digest(token)) return false;
        if (!record.revoked) this.markRevoked(path, record);
      } else if (!session.revoked) this.markRevoked(this.path('sessions', token), session);
      return true;
    } catch { return false; }
  }
  /** Recovery proof grants only irreversible revocation across packaged origins.
   * Missing/expired/bulk-removed capabilities are already inactive. */
  revokeRecovery(secret: string, origin: string): boolean {
    if (!valid(secret) || !packagedSource(origin)) return false;
    try {
      const path = this.path('recoveries', secret);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (!record.revoked) this.markRevoked(path, record);
      return true;
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  }
  revocationSubject(secret: string, origin: string): string | undefined {
    return valid(secret) && packagedSource(origin) && this.recovery(secret) ? digest(secret) : undefined;
  }
  revocationCredentialMissing(token: string): boolean {
    if (!valid(token)) return false;
    try { readFileSync(this.path('sessions', token), 'utf8'); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  }
  allowsRevocationOrigin(origin: string): boolean {
    // No data is returned. Legacy HTTPS clients need a readable inactive receipt
    // even after bulk removal deletes their last exact-origin session record.
    // Existing tokens still require their exact stored origin to revoke anything.
    if (origin === 'null') return this.allowsOrigin(origin);
    try { return appOrigin(origin) === origin; } catch { return false; }
  }
  /** Internal stable subject for consent across packaged-app token rotation. Never expose the hash to a client. */
  subject(token: string, origin: string): string | undefined {
    if (!this.authorized(token, origin)) return;
    try {
      const session = JSON.parse(readFileSync(this.path('sessions', token), 'utf8'));
      return session.recoveryHash ?? digest(token);
    } catch { return; }
  }
  /** The bridge can validate a sharing owner without possessing a phone token.
   * Older sessions use their session hash; recovery-capable sessions keep their
   * owner through port rotation. Never expose either hash in a status response. */
  authorizedSubject(subject: string): boolean {
    if (!fileName.test(`${subject}.json`)) return false;
    try {
      const generation = pairingGeneration(this.directory);
      let sessionHash = subject;
      let recovery: { revoked?: boolean; currentSession: string; expiresAt: number; generation?: string } | undefined;
      try {
        recovery = JSON.parse(readFileSync(join(this.directory, 'recoveries', `${subject}.json`), 'utf8'));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
      if (recovery) {
        if (recovery.revoked || !currentPairingGeneration(recovery, generation) || !fileName.test(`${recovery.currentSession}.json`)) return false;
        sessionHash = recovery.currentSession;
      }
      const session = JSON.parse(readFileSync(join(this.directory, 'sessions', `${sessionHash}.json`), 'utf8'));
      return !session.revoked && currentPairingGeneration(session, generation) && Number.isFinite(session.expiresAt) && session.expiresAt > this.clock()
        && (recovery ? session.recoveryHash === subject && session.expiresAt === recovery.expiresAt : !session.recoveryHash);
    } catch { return false; }
  }
  /** Recovery is a distinct 256-bit capability, not an existing data token.
   * Retrying after a lost response issues a fresh session and revokes the prior
   * one. The original 90-day expiry never extends. Atomic pointer replacement
   * makes stale session files unusable even if interrupted before cleanup.
   */
  resume(secret: string, origin: string): { token: string; expiresAt: number; resumeToken: string } | undefined {
    if (!valid(secret) || !packagedSource(origin)) return;
    const record = this.recovery(secret);
    if (!record || record.runtimeOwner) return;
    const generation = record.generation ?? 'initial';
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= this.clock() || !/^[a-f0-9]{64}$/.test(record.currentSession)) return;
    const token = randomBytes(32).toString('base64url');
    const sessionPath = this.path('sessions', token);
    writeFileSync(sessionPath, JSON.stringify({ origin, expiresAt: record.expiresAt, recoveryHash: digest(secret), generation }), { mode: 0o600, flag: 'wx' });
    const recoveryPath = this.path('recoveries', secret);
    const temporary = `${recoveryPath}.next`;
    try {
      writeFileSync(temporary, JSON.stringify({ currentSession: digest(token), expiresAt: record.expiresAt, generation }), { mode: 0o600 });
      renameSync(temporary, recoveryPath);
    } catch (error) { try { unlinkSync(sessionPath); } catch {} throw error; }
    try { unlinkSync(join(this.directory, 'sessions', `${record.currentSession}.json`)); } catch {}
    return { token, expiresAt: record.expiresAt, resumeToken: secret };
  }
  allowsResumeOrigin(origin: string): boolean { return packagedSource(origin); }
  /** Only the pairing endpoint may bootstrap a source not known before installation.
   * A live locally issued invite and a packaged iOS loopback source are required.
   * Possession of the 256-bit code is still checked by exchange; this grants no
   * data access. The resulting session binds to the exact requesting origin.
   */
  allowsPairingOrigin(origin: string): boolean {
    if (this.allowsOrigin(origin)) return true;
    if (!packagedSource(origin)) return false;
    for (const name of readdirSync(join(this.directory, 'invitations'))) {
      if (!fileName.test(name)) continue;
      try {
        const data = JSON.parse(readFileSync(join(this.directory, 'invitations', name), 'utf8'));
        if (currentPairingGeneration(data, pairingGeneration(this.directory)) && data.origin === undefined && Number.isFinite(data.expiresAt) && data.expiresAt > this.clock()) return true;
      } catch {}
    }
    return false;
  }
  allowsOrigin(origin: string): boolean {
    // Only a live invitation issued locally or a live paired session opens CORS.
    // Merely receiving a request from an origin never authorizes it.
    for (const kind of ['invitations', 'sessions']) {
      for (const name of readdirSync(join(this.directory, kind))) {
        if (!fileName.test(name)) continue;
        try {
          const data = JSON.parse(readFileSync(join(this.directory, kind, name), 'utf8'));
          if (currentPairingGeneration(data, pairingGeneration(this.directory)) && data.origin === origin && Number.isFinite(data.expiresAt) && data.expiresAt > this.clock() && (kind !== 'sessions' || this.sessionActive(data, name.slice(0, -5)))) return true;
        } catch {}
      }
    }
    return false;
  }
  revokeAll(): { cleanupComplete: boolean } {
    // One atomic replacement revokes every existing capability, even if a
    // process crashes or a record cannot be deleted. Issuance/resume that raced
    // with this change keeps its original generation and cannot restore access.
    const generation = randomBytes(32).toString('hex');
    const path = join(this.directory, 'generation.json');
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ generation }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
    let cleanupComplete = true;
    for (const kind of ['invitations', 'sessions', 'recoveries']) {
      try {
        for (const name of readdirSync(join(this.directory, kind))) {
          if (!fileName.test(name)) continue;
          const recordPath = join(this.directory, kind, name);
          try {
            // Do not delete a new registration created after revocation.
            const record = JSON.parse(readFileSync(recordPath, 'utf8'));
            if (currentPairingGeneration(record, generation)) continue;
            unlinkSync(recordPath);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupComplete = false; }
        }
      } catch { cleanupComplete = false; }
    }
    return { cleanupComplete };
  }
}
