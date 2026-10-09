import { readFile, readdir, access, lstat, mkdir, cp, rename, mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { ownedService, serviceNames } from './service-management.mjs';
import { run } from './setup.mjs';

export const exists = path => access(path).then(() => true, () => false);
export async function projectIdentity(directory) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    return pkg.name === 'even-g2-dot';
  } catch { return false; }
}

/** Only known Dot Link locations and its exact service labels are inspected. */
export async function discoverInstallation({ home = homedir(), execute = run } = {}) {
  const managed = join(home, 'Library/Application Support/Dot Link');
  const configured = new Set(); let serviceRoot;
  for (const name of serviceNames) {
    const plistPath = join(home, 'Library/LaunchAgents', `local.even-g2-dot.${name}.plist`);
    if (!await exists(plistPath)) continue;
    let plist;
    try { plist = JSON.parse(await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath])); }
    catch { throw new Error('EXISTING_SERVICE_UNREADABLE'); }
    const directory = plist.WorkingDirectory;
    if (typeof directory !== 'string' || !ownedService(plist, directory, name, {home}) || !await projectIdentity(directory)) throw new Error('EXISTING_SERVICE_CONFLICT');
    if (serviceRoot && directory !== serviceRoot) throw new Error('MULTIPLE_INSTALLATIONS');
    serviceRoot = directory; configured.add(directory);
  }
  for (const directory of [managed, join(home, 'even-g2-dot'), join(home, 'Desktop/even-g2-dot')]) {
    if (await projectIdentity(directory) && (await exists(join(directory, '.runtime/device-key')) || await exists(join(directory, '.runtime/install.json')))) configured.add(directory);
  }
  if (configured.size > 1) throw new Error('MULTIPLE_INSTALLATIONS');
  const directory = serviceRoot ?? [...configured][0] ?? managed;
  if (!configured.size && await exists(managed)) {
    // A folder belonging to another app or an unknown partial install is not replaced.
    throw new Error('INSTALL_FOLDER_OCCUPIED');
  }
  return { directory, installed: configured.size === 1, existing: configured.size === 1 && directory !== managed,
    legacyTerminalPresent: await exists(join(home, 'Desktop/Even-G2')) };
}

/** New installs are staged then atomically placed; existing installs are never overwritten. */
export async function installPayload(payload, destination, { home = homedir() } = {}) {
  const expected = join(home, 'Library/Application Support/Dot Link');
  if (resolve(destination) !== resolve(expected)) throw new Error('INSTALL_DESTINATION_INVALID');
  if (!await projectIdentity(payload)) throw new Error('INSTALL_PAYLOAD_INVALID');
  if (await exists(destination)) throw new Error('INSTALL_FOLDER_OCCUPIED');
  await mkdir(dirname(destination), { recursive: true });
  const stage = await mkdtemp(join(dirname(destination), '.Dot-Link-install-'));
  await chmod(stage, 0o700);
  try {
    for (const entry of await readdir(payload)) {
      await cp(join(payload, entry), join(stage, entry), { recursive: true, errorOnExist: true, force: false });
    }
    await mkdir(join(stage, '.runtime'), { recursive: true, mode: 0o700 });
    await writeFile(join(stage, '.runtime/install.json'), JSON.stringify({ product: 'Dot Link', format: 1, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    await rename(stage, destination);
    return destination;
  } catch (error) {
    // Keep a failed staging directory for inspection; never delete a user directory.
    throw error;
  }
}

export function nextSetupStep(state) {
  if (state.conflict) return 'conflict';
  if (!state.installed || !state.dependencies) return 'install';
  if (!state.tailscaleConnected) return 'network';
  if (state.networkConflict) return 'networkConflict';
  if (!state.tunnelConfigured) return 'dot';
  if (!state.bridge || !state.device || !state.tunnel) return 'start';
  if (!state.subscribed) return 'subscribe';
  return 'pair';
}
