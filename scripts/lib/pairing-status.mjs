import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Read-only summary: never expose credentials, renew sessions or prune files.
export async function pairingStatus(directory, now = Date.now()) {
  const root = join(directory, '.runtime/pairing');
  let names;
  try { names = await readdir(join(root, 'sessions')); }
  catch (error) { return { evenPairingKnown: error.code === 'ENOENT', evenPaired: false }; }
  let unreadable = false;
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const s = JSON.parse(await readFile(join(root, 'sessions', name), 'utf8'));
      if (!Number.isFinite(s.expiresAt) || s.expiresAt <= now) continue;
      const origin = new URL(s.origin);
      if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== s.origin) continue;
      if (s.recoveryHash) {
        if (!/^[a-f0-9]{64}$/.test(s.recoveryHash)) continue;
        let r;
        try { r = JSON.parse(await readFile(join(root, 'recoveries', `${s.recoveryHash}.json`), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (r.currentSession !== name.slice(0, -5) || r.expiresAt !== s.expiresAt) continue;
      }
      return { evenPairingKnown: true, evenPaired: true };
    } catch { unreadable = true; }
  }
  return { evenPairingKnown: !unreadable, evenPaired: false };
}
