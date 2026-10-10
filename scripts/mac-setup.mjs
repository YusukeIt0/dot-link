import { readFile, writeFile, mkdir, open, rename, chmod, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { discoverInstallation, installPayload, exists, nextSetupStep } from './lib/mac-install.mjs';
import { installMenuApp, registerMenuApp } from './lib/menu-install.mjs';
import { prepareUpdate, finishUpdate } from './lib/app-update.mjs';
import { lifecycleState, suspendServices, resumeServices, waitForRelay } from './lib/app-lifecycle.mjs';
import { uninstallPlan, uninstallApp } from './lib/app-uninstall.mjs';
import { pairingStatus } from './lib/pairing-status.mjs';
import { legacyNotificationState, retireLegacyNotifications } from './lib/notification-migration.mjs';
import { tailscale, run, executable, assertOwnedAgents } from './lib/setup.mjs';

const payload = fileURLToPath(new URL('..', import.meta.url));
const action = process.argv[2] ?? 'inspect';
const appBundle = resolve(payload, '../../..');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let inputText = '';
for await (const chunk of process.stdin) {
  inputText += chunk;
  if (inputText.length > 20000) throw new Error('INPUT_TOO_LARGE');
  if (inputText.includes('\n')) { inputText = inputText.slice(0, inputText.indexOf('\n')); break; }
}
let input = {};
try { input = JSON.parse(inputText || '{}'); } catch { emit({ kind: 'error', code: 'INVALID_INPUT' }); process.exit(1); }

async function inspect() {
  const installation = await discoverInstallation();
  const directory = installation.directory;
  process.chdir(installation.installed ? directory : payload);
  let network;
  try { network = await tailscale(); } catch {}
  const tsInstalled = !!await executable(['/Applications/Tailscale.app/Contents/MacOS/Tailscale', join(homedir(), 'Applications/Tailscale.app/Contents/MacOS/Tailscale'), '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']);
  const model = join(directory, '.runtime/models/ggml-small.bin');
  const dependencies = installation.installed && await exists(model) && !!await executable([join(directory, '.runtime/bin/whisper-cli'), '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']) && !!await executable([join(directory, '.runtime/bin/tunnel-client'), '/opt/homebrew/bin/tunnel-client', '/usr/local/bin/tunnel-client']);
  const tunnelConfigured = installation.installed && await exists(join(directory, '.runtime/tunnel.yaml'));
  let health = {};
  if (installation.installed) {
    try { health = JSON.parse(await run(process.execPath, [join(payload, 'scripts/setup-status.mjs'), directory], { timeout: 15000 })); } catch {}
  }
  const pairing = installation.installed ? await pairingStatus(directory) : { evenPairingKnown: true, evenPaired: false };
  const lifecycle = installation.installed ? await lifecycleState(directory) : {};
  const state = { ...installation, ...pairing, ...lifecycle, dependencies, tailscaleInstalled: tsInstalled, tailscaleConnected: !!network,
    networkConflict: ['conflict', 'public'].includes(network?.state), tunnelConfigured,
    bridge: health.bridge === true, device: health.device === true, tunnel: health.tunnel === true, subscribed: health.subscribed === true };
  state.legacyNotificationRegistered = installation.installed ? (await legacyNotificationState(directory)).registered : false;
  state.step = nextSetupStep(state);
  return state;
}

async function downloadModel(directory) {
  const manifest = JSON.parse(await readFile(join(payload, 'scripts/mac-runtime-manifest.json'), 'utf8'));
  const target = join(directory, '.runtime/models/ggml-small.bin');
  if (await exists(target)) return; // Preserve an existing operator-provided model.
  await mkdir(join(directory, '.runtime/models'), { recursive: true, mode: 0o700 });
  const temp = target + '.downloading';
  const response = await fetch(manifest.model.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error('MODEL_DOWNLOAD_FAILED');
  const handle = await open(temp, 'w', 0o600); const hash = createHash('sha256');
  let bytes = 0, lastProgress = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > manifest.model.bytes) throw new Error('MODEL_SIZE_INVALID');
      hash.update(chunk); await handle.write(chunk);
      if (Date.now() - lastProgress > 1000) { lastProgress = Date.now(); emit({ kind: 'progress', task: 'model', percent: Math.floor(bytes / manifest.model.bytes * 100) }); }
    }
  } finally { await handle.close(); }
  if (bytes !== manifest.model.bytes || hash.digest('hex') !== manifest.model.sha256) throw new Error('MODEL_CHECKSUM_FAILED');
  if (await exists(target)) throw new Error('MODEL_ALREADY_PRESENT');
  await rename(temp, target);
}

async function prepare() {
  let found = await discoverInstallation();
  if (!found.installed) {
    emit({ kind: 'progress', task: 'install', percent: 0 });
    await installPayload(payload, found.directory);
    found = await discoverInstallation();
  }
  if (found.existing) throw new Error('EXISTING_INSTALL_REQUIRES_REVIEW');
  await assertOwnedAgents(found.directory);
  await downloadModel(found.directory);
  await run(process.execPath, [join(found.directory, 'server/init.ts')], { cwd: found.directory });
  return inspect();
}

async function saveTunnel() {
  const found = await discoverInstallation();
  if (!found.installed) throw new Error('INSTALL_FIRST');
  if (await exists(join(found.directory, '.runtime/tunnel.yaml'))) throw new Error('TUNNEL_ALREADY_CONFIGURED');
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const secret = typeof input.secret === 'string' ? input.secret.trim() : '';
  if (!/^tunnel_[A-Za-z0-9_-]{16,128}$/.test(id) || !/^sk-[A-Za-z0-9_-]{20,1000}$/.test(secret)) throw new Error('TUNNEL_INPUT_INVALID');
  await run(process.execPath, [join(found.directory, 'server/init.ts')], { cwd: found.directory });
  const keyFile = join(found.directory, '.runtime/tunnel-api-key');
  await writeFile(keyFile, secret, { mode: 0o600, flag: 'wx' });
  input.secret = ''; inputText = '';
  try { await run(process.execPath, [join(found.directory, 'scripts/prepare-tunnel.mjs'), id], { cwd: found.directory }); }
  catch { throw new Error('TUNNEL_SAVE_FAILED'); }
  return inspect();
}

try {
  let result;
  if (action === 'update-prepare') { const found = await discoverInstallation(); result = await prepareUpdate(found.directory); }
  else if (action === 'update-adopt') { const found = await discoverInstallation(); await prepareUpdate(found.directory, {bootstrap:true}); await finishUpdate(found.directory); result = await inspect(); }
  else if (action === 'update-recover') { const found = await discoverInstallation(); await finishUpdate(found.directory); result = await inspect(); }
  else if (action === 'update-abort') { const found = await discoverInstallation(); result = await finishUpdate(found.directory, {rollback:true}); }
  else if (action === 'inspect') result = await inspect();
  else if (action === 'prepare') result = await prepare();
  else if (action === 'save-tunnel') result = await saveTunnel();
  else if (action === 'resume') {
    const found = await discoverInstallation();
    if (!found.installed) throw new Error('INSTALL_FIRST');
    await resumeServices(found.directory);
    result = await waitForRelay(inspect);
  } else if (action === 'activate') {
    const found = await discoverInstallation();
    if (!found.installed) throw new Error('INSTALL_FIRST');
    const response = JSON.parse(await run(process.execPath, [join(payload, 'scripts/setup.mjs'), 'install', '--voice-only', '--directory', found.directory], { cwd: found.directory, timeout: 120000 }));
    if (!response.changed && !response.message) throw new Error('SERVICE_START_FAILED');
    const menuApp = await installMenuApp(resolve(payload, '../../..'));
    await registerMenuApp(menuApp);
    await prepareUpdate(found.directory, {bootstrap:true});
    await finishUpdate(found.directory);
    result = await waitForRelay(inspect);
  } else if (action === 'migrate-notifications') {
    const found = await discoverInstallation();
    if (!found.installed) throw new Error('INSTALL_FIRST');
    await retireLegacyNotifications(found.directory);
    result = await inspect();
  } else if (action === 'pause' || action === 'shutdown') {
    const found = await discoverInstallation();
    if (found.installed) await suspendServices(found.directory, {reason:action === 'shutdown' ? 'quit' : 'pause'});
    result = action === 'shutdown' ? { quitReady: true } : await inspect();
  } else if (action === 'uninstall-plan') {
    const found = await discoverInstallation();
    const plan = await uninstallPlan(found.directory, appBundle);
    result = { uninstallPlan: { token: plan.token, removes: plan.removes, dataDirectory: plan.runtime, retainsSource: plan.retainsSource, managed: plan.managed } };
  } else if (action === 'uninstall') {
    const found = await discoverInstallation();
    if (input.deleteData !== 'true') throw new Error('INVALID_UNINSTALL_OPTION');
    result = await uninstallApp(found.directory, appBundle, {token:input.token,deleteData:input.deleteData === 'true'});
  } else if (action === 'pair') {
    const state = await inspect();
    if (state.step !== 'pair') throw new Error('RELAY_NOT_READY');
    await run(process.execPath, [join(state.directory, 'scripts/beta-pair.mjs')], { cwd: state.directory });
    const code = await readFile(join(state.directory, '.runtime/beta-pairing.txt'), 'utf8');
    const invitation = JSON.parse(code);
    result = { ...state, pairingCode: code, expiresAt: invitation.expiresAt };
  } else throw new Error('UNKNOWN_ACTION');
  emit({ kind: 'result', ...result });
} catch (error) {
  const safe = typeof error.message === 'string' && /^[A-Z_]{3,60}$/.test(error.message) ? error.message : 'SETUP_FAILED';
  emit({ kind: 'error', code: safe }); process.exitCode = 1;
}
