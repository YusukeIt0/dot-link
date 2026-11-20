import { z } from 'zod';
import type { ArchiveAuthority } from './archive-authority.ts';
import type { EnvironmentHistory } from './environment-history.ts';

export interface FactorArchives { authority: ArchiveAuthority; environment: EnvironmentHistory }

// Device-only protocol. A live source grant or an older client's location-history
// toggle does not express permission to retain forecast or route evidence.
export const archiveTerms = 'selected-factor-history-v1';
const source = z.enum(['weather', 'mobility']);
const choice = z.discriminatedUnion('action', [
  z.object({action: z.literal('set'), source, enabled: z.boolean()}).strict(),
  z.object({action: z.literal('delete'), source}).strict(),
  z.object({action: z.literal('period'), period: z.enum(['7d', '1m', '6m', '1y'])}).strict(),
]);
const command = z.object({protocol: z.literal(1), epoch: z.uuid(), terms: z.literal(archiveTerms).optional(), change: choice}).strict();
function view(state: Awaited<ReturnType<ArchiveAuthority['status']>>) {
  return {protocol: 1, terms: archiveTerms, epoch: state.epoch, period: state.period,
    sources: {weather: state.sources.weather, mobility: state.sources.mobility}};
}
export async function archiveSettings(authority: ArchiveAuthority, owner: string) {
  return view(await authority.status(owner));
}
export async function changeArchiveSettings(authority: ArchiveAuthority, owner: string, raw: unknown) {
  const input = command.parse(raw);
  if ((input.change.action === 'period' || (input.change.action === 'set' && input.change.enabled)) &&
      input.terms !== archiveTerms) throw new Error('HISTORY_ARCHIVE_TERMS_REQUIRED');
  return view(await authority.control(owner, input.epoch, input.change));
}
