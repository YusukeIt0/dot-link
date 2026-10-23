import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pairingGeneration, currentPairingGeneration } from '../../server/pairing-generation.ts';
import { appOrigin } from '../../src/relay-origin.ts';

// Read-only summary: never expose credentials, renew sessions or prune files.
export async function pairingStatus(directory, now = Date.now()) {
  const root = join(directory, '.runtime/pairing');
  const empty = { evenPairingKnown: true, evenPaired: false, evenPairingCount: 0, evenInvitationCount: 0 };
  let names, generation;
  try { generation = pairingGeneration(root); }
  catch { return { ...empty, evenPairingKnown: false }; }
  try { names = await readdir(join(root, 'sessions')); }
  catch (error) { return { ...empty, evenPairingKnown: error.code === 'ENOENT' }; }
  let unreadable = false, count = 0, invitations = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const s = JSON.parse(await readFile(join(root, 'sessions', name), 'utf8'));
      if (s.revoked || !currentPairingGeneration(s, generation)) continue;
      if (!Number.isFinite(s.expiresAt) || s.expiresAt <= now) continue;
      if (appOrigin(s.origin) !== s.origin) continue;
      if (s.recoveryHash) {
        if (!/^[a-f0-9]{64}$/.test(s.recoveryHash)) continue;
        let r;
        try { r = JSON.parse(await readFile(join(root, 'recoveries', `${s.recoveryHash}.json`), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (r.revoked || !currentPairingGeneration(r, generation) || r.currentSession !== name.slice(0, -5) || r.expiresAt !== s.expiresAt) continue;
      }
      count++;
    } catch { unreadable = true; }
  }
  try {
    for (const name of await readdir(join(root, 'invitations'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const invite = JSON.parse(await readFile(join(root, 'invitations', name), 'utf8'));
        if (currentPairingGeneration(invite, generation) && Number.isFinite(invite.expiresAt) && invite.expiresAt > now) invitations++;
      } catch { unreadable = true; }
    }
  } catch (error) { if (error.code !== 'ENOENT') unreadable = true; }
  // A concurrent revoke means this scan is stale, never a verified count.
  try { if (pairingGeneration(root) !== generation) unreadable = true; }
  catch { unreadable = true; }
  return { evenPairingKnown: !unreadable, evenPaired: count > 0, evenPairingCount: count, evenInvitationCount: invitations };
}
