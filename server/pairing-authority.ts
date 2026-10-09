import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appOrigin, relayOrigin, type PairingInvite } from '../src/relay-origin.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const valid = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const fileName = /^[a-f0-9]{64}\.json$/;
const INVITE_LIFETIME = 120000;
const packagedSource = (origin: string): boolean => {
  try { return appOrigin(origin).startsWith('http://127.0.0.1:'); } catch { return false; }
};
const SESSION_LIFETIME = 90 * 24 * 60 * 60 * 1000;

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
  private prune(kind: 'invitations' | 'sessions' | 'recoveries'): number {
    let active = 0;
    for (const name of readdirSync(join(this.directory, kind))) {
      if (!fileName.test(name)) continue;
      const path = join(this.directory, kind, name);
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (!Number.isFinite(data.expiresAt) || data.expiresAt <= this.clock()) unlinkSync(path);
        else active++;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return active;
  }
  issue(origin: string, allowedAppOrigin?: string): PairingInvite {
    origin = relayOrigin(origin);
    if (allowedAppOrigin !== undefined) allowedAppOrigin = appOrigin(allowedAppOrigin);
    if (this.prune('invitations') >= 5) throw new Error('Too many active pairing invitations');
    const code = randomBytes(32).toString('base64url');
    const expiresAt = this.clock() + INVITE_LIFETIME;
    writeFileSync(this.path('invitations', code), JSON.stringify({ expiresAt, origin: allowedAppOrigin }), { mode: 0o600, flag: 'wx' });
    return { version: 1, origin, code, expiresAt };
  }
  exchange(code: string, origin: string): { token: string; expiresAt: number; resumeToken?: string } | undefined {
    if (!valid(code)) return;
    let invitation: { expiresAt: number; origin?: string };
    try { invitation = JSON.parse(readFileSync(this.path('invitations', code), 'utf8')); } catch { return; }
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
    writeFileSync(this.path('sessions', token), JSON.stringify({ origin, expiresAt, recoveryHash }), { mode: 0o600, flag: 'wx' });
    if (resumeToken) writeFileSync(this.path('recoveries', resumeToken), JSON.stringify({ currentSession: digest(token), expiresAt }), { mode: 0o600, flag: 'wx' });
    return { token, expiresAt, ...(resumeToken ? { resumeToken } : {}) };
  }
  authorized(token: string, origin: string): boolean {
    if (!valid(token)) return false;
    try {
      const session = JSON.parse(readFileSync(this.path('sessions', token), 'utf8'));
      if (session.origin !== origin || !Number.isFinite(session.expiresAt) || session.expiresAt <= this.clock()) return false;
      if (session.recoveryHash) {
        if (!/^[a-f0-9]{64}$/.test(session.recoveryHash)) return false;
        const recovery = JSON.parse(readFileSync(join(this.directory, 'recoveries', `${session.recoveryHash}.json`), 'utf8'));
        if (recovery.currentSession !== digest(token) || recovery.expiresAt !== session.expiresAt) return false;
      }
      return true;
    } catch { return false; }
  }
  revoke(token: string, origin: string): boolean {
    if (!this.authorized(token, origin)) return false;
    try {
      const session = JSON.parse(readFileSync(this.path('sessions', token), 'utf8'));
      if (session.recoveryHash && /^[a-f0-9]{64}$/.test(session.recoveryHash)) unlinkSync(join(this.directory, 'recoveries', `${session.recoveryHash}.json`));
      unlinkSync(this.path('sessions', token)); return true;
    } catch { return false; }
  }
  /** Recovery is a distinct 256-bit capability, not an existing data token.
   * Retrying after a lost response issues a fresh session and revokes the prior
   * one. The original 90-day expiry never extends. Atomic pointer replacement
   * makes stale session files unusable even if interrupted before cleanup.
   */
  resume(secret: string, origin: string): { token: string; expiresAt: number; resumeToken: string } | undefined {
    if (!valid(secret) || !packagedSource(origin)) return;
    let record: { currentSession: string; expiresAt: number };
    try { record = JSON.parse(readFileSync(this.path('recoveries', secret), 'utf8')); } catch { return; }
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= this.clock() || !/^[a-f0-9]{64}$/.test(record.currentSession)) return;
    const token = randomBytes(32).toString('base64url');
    const sessionPath = this.path('sessions', token);
    writeFileSync(sessionPath, JSON.stringify({ origin, expiresAt: record.expiresAt, recoveryHash: digest(secret) }), { mode: 0o600, flag: 'wx' });
    const recoveryPath = this.path('recoveries', secret);
    const temporary = `${recoveryPath}.next`;
    try {
      writeFileSync(temporary, JSON.stringify({ currentSession: digest(token), expiresAt: record.expiresAt }), { mode: 0o600 });
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
        if (data.origin === undefined && Number.isFinite(data.expiresAt) && data.expiresAt > this.clock()) return true;
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
          if (data.origin === origin && Number.isFinite(data.expiresAt) && data.expiresAt > this.clock()) return true;
        } catch {}
      }
    }
    return false;
  }
  revokeAll(): void {
    for (const kind of ['invitations', 'sessions', 'recoveries']) {
      for (const name of readdirSync(join(this.directory, kind))) {
        if (fileName.test(name)) { try { unlinkSync(join(this.directory, kind, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
      }
    }
  }
}
