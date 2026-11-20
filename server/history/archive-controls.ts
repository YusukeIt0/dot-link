import type { LocationHistoryStore } from './store.ts';
import type { HealthContext } from '../health/context.ts';
import { z } from 'zod';
import type { ArchiveAuthority } from './archive-authority.ts';
import type { EnvironmentHistory } from './environment-history.ts';

export interface FactorArchives { authority: ArchiveAuthority; environment: EnvironmentHistory }

// Device-only protocol. A live source grant or an older client's location-history
// toggle does not express permission to retain forecast or route evidence.
export const archiveTerms = 'selected-factor-history-v1';
const source = z.enum(['weather', 'mobility', 'polar', 'location']);
const choice = z.discriminatedUnion('action', [
  z.object({action: z.literal('set'), source, enabled: z.boolean()}).strict(),
  z.object({action: z.literal('delete'), source}).strict(),
  z.object({action: z.literal('period'), period: z.enum(['7d', '1m', '6m', '1y'])}).strict(),
]);
const command = z.object({protocol: z.literal(1), epoch: z.uuid(), polarEpoch: z.uuid().optional(), terms: z.literal(archiveTerms).optional(), change: choice}).strict();
function view(state: Awaited<ReturnType<ArchiveAuthority['status']>>) {
  return {protocol: 1, terms: archiveTerms, epoch: state.epoch, period: state.period,
    sources: {weather: state.sources.weather, mobility: state.sources.mobility}};
}
type LocationControls = Pick<LocationHistoryStore, 'controlArchive'>;
type PolarControls = Pick<HealthContext, 'archiveStatus' | 'archiveControl'>;
export async function archiveSettings(authority: ArchiveAuthority, owner: string, health?: PolarControls, locations?: LocationControls) {
  const policy = await authority.status(owner);
  const result = view(policy);
  const common = {...result, sources: {...result.sources, ...(locations ? {location:policy.sources.location} : {})}};
  if (!health) return common;
  // One unavailable source must leave all remaining source controls available.
  const polar = await health.archiveStatus(owner).catch(() => undefined);
  return {...common, sources: {...common.sources, polar: polar?.enabled ?? false},
    polarAvailable: polar?.available ?? false, ...(polar?.epoch ? {polarEpoch:polar.epoch} : {})};
}
export async function changeArchiveSettings(authority: ArchiveAuthority, owner: string, raw: unknown, health?: PolarControls, locations?: LocationControls) {
  const input = command.parse(raw);
  const update = input.change;
  if ((update.action === 'period' || (update.action === 'set' && update.enabled)) &&
      input.terms !== archiveTerms) throw new Error('HISTORY_ARCHIVE_TERMS_REQUIRED');
  if (update.action === 'period') {
    if (input.polarEpoch) throw new Error('HISTORY_ARCHIVE_ACCESS_CHANGED');
    await authority.control(owner, input.epoch, update);
  } else if (update.source === 'location') {
    if (!locations || input.polarEpoch) throw new Error('HISTORY_ARCHIVE_ACCESS_CHANGED');
    await locations.controlArchive(owner, input.epoch, {...update, source:'location'});
  } else if (update.source === 'polar') {
    if (!health || !input.polarEpoch) throw new Error('HISTORY_ARCHIVE_ACCESS_CHANGED');
    const status = await health.archiveStatus(owner);
    if (status.epoch !== input.polarEpoch || (update.action === 'set' && update.enabled && !status.available))
      throw new Error('HISTORY_ARCHIVE_ACCESS_CHANGED');
    if (update.action === 'set' && update.enabled) await authority.bindPeriod(owner, input.epoch);
    else if ((await authority.status(owner)).epoch !== input.epoch) throw new Error('HISTORY_ARCHIVE_ACCESS_CHANGED');
    await health.archiveControl(owner, input.polarEpoch,
      update.action === 'delete' ? {action:'delete'} : {action:'set', enabled:update.enabled},
      update.action === 'set' && update.enabled ? () => authority.periodFor(owner, input.epoch) !== undefined : undefined);
  } else {
    if (input.polarEpoch) throw new Error('HISTORY_ARCHIVE_ACCESS_CHANGED');
    await authority.control(owner, input.epoch, {...update, source:update.source});
  }
  return archiveSettings(authority,owner,health,locations);
}
