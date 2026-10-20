import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { PairingAuthority } from '../../server/pairing-authority.ts';
import { pairingStatus } from './pairing-status.mjs';

// Local only: works with the relay paused/offline and never starts services.
export async function removeEvenPairings(directory) {
  let removal;
  try { removal = new PairingAuthority(join(directory, '.runtime/pairing')).revokeAll(); }
  catch {
    return { ...(await pairingStatus(directory)), pairingRemoval: 'failed' };
  }
  for (const name of ['beta-pairing.txt', 'beta-pairing.png']) {
    try { await unlink(join(directory, '.runtime', name)); }
    catch (error) { if (error.code !== 'ENOENT') removal.cleanupComplete = false; }
  }
  const state = await pairingStatus(directory);
  return {
    ...state,
    pairingRemoval: !state.evenPairingKnown ? 'unverified' : state.evenPairingCount || state.evenInvitationCount ? 'changed' : 'removed',
    pairingCleanupComplete: removal.cleanupComplete,
  };
}
