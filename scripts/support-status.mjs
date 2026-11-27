import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverInstallation } from './lib/mac-install.mjs';
import { lifecycleState } from './lib/app-lifecycle.mjs';
import { pairingStatus } from './lib/pairing-status.mjs';

// Only definite absence is false. An unreadable or unexpected entry is unknown.
export async function savedFile(path) {
  try { return (await lstat(path)).isFile() ? true : null; }
  catch (error) { return error.code === 'ENOENT' ? false : null; }
}

// The terminal entry point reads local configuration. Live checks belong to the
// running Mac window. No service is started and no credential is sent or returned.
export async function savedSupportFacts({home} = {}) {
  let installation;
  try { installation = await discoverInstallation({home, verifyAccess:true}); }
  catch (error) {
    const conflict = ['EXISTING_SERVICE_CONFLICT', 'MULTIPLE_INSTALLATIONS', 'INSTALL_FOLDER_OCCUPIED'].includes(error.message);
    return {step:conflict ? 'conflict' : 'unknown'};
  }
  if (!installation.installed) return {installed:false, step:'install'};
  const {directory, existing} = installation;
  const facts = {installed:true, existing};
  const journal = join(directory, '.runtime/app-update.json');
  const recovery = await savedFile(journal);
  if (recovery !== false) return {...facts, step:recovery ? 'updateRecovery' : 'unknown'};
  try {
    const {lifecycleStopped, lifecycleReason} = await lifecycleState(directory, {reportUnknown:true});
    facts.lifecycleStopped = lifecycleStopped;
    facts.lifecycleReason = lifecycleReason;
  } catch { /* The saved intent could not be determined. */ }
  facts.savedTunnel = await savedFile(join(directory, '.runtime/tunnel.yaml'));
  const pairing = await pairingStatus(directory);
  facts.evenPairingKnown = pairing.evenPairingKnown;
  facts.evenPaired = pairing.evenPaired;
  // Check again after reading the individual records. An update may have
  // started during this observation. Only the GUI decides whether it can act.
  const recheck = await savedFile(journal);
  if (recheck !== false) return {installed:true, existing, step:recheck ? 'updateRecovery' : 'unknown'};
  return facts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) process.exit(64);
  const finish = facts => process.stdout.write(JSON.stringify(facts) + '\n', () => process.exit(0));
  // A read of a disconnected volume can outlive a rejected Promise.
  const timeout = setTimeout(() => finish({step:'unknown'}), 15000);
  try { finish(await savedSupportFacts()); } catch { finish({step:'unknown'}); }
  clearTimeout(timeout);
}
