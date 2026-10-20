import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared by the running relay and the local Mac helper. Missing is the
 * pre-revocation format; unreadable/corrupt state must never restore access. */
export function pairingGeneration(directory: string): string {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'generation.json'), 'utf8'));
    if (typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.generation)) throw new Error('Invalid pairing generation');
    return value.generation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'initial';
    throw error;
  }
}

export function currentPairingGeneration(record: { generation?: string }, generation: string): boolean {
  return (record.generation ?? 'initial') === generation;
}
