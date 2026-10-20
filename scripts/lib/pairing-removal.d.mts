import type { PairingStatus } from './pairing-status.mjs';
export function removeEvenPairings(directory: string): Promise<PairingStatus & {
  pairingRemoval: 'failed' | 'unverified' | 'changed' | 'removed';
  pairingCleanupComplete?: boolean;
}>;
