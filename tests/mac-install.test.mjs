import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverInstallation, installPayload, nextSetupStep } from '../scripts/lib/mac-install.mjs';
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dot-link-install-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, destination: join(home, 'Library/Application Support/Dot Link') };
}
async function payloadAt(path) {
  await mkdir(join(path, '.runtime/bin'), { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'even-g2-dot' }));
  await writeFile(join(path, '.runtime/bin/example'), 'fixture');
}
test('new Mac installs payload and discovers it without overwriting on retry', async t => {
  const {home, destination} = await fixture(t);
  const payload = join(home, 'payload'); await payloadAt(payload);
  assert.equal((await discoverInstallation({home})).installed, false);
  await installPayload(payload, destination, {home});
  assert.equal(await readFile(join(destination, '.runtime/bin/example'), 'utf8'), 'fixture');
  const found = await discoverInstallation({home});
  assert.equal(found.installed, true); assert.equal(found.existing, false);
  await assert.rejects(installPayload(payload, destination, {home}), /INSTALL_FOLDER_OCCUPIED/);
});
test('unknown and empty destinations are consistently protected', async t => {
  const {home, destination} = await fixture(t);
  await mkdir(destination, {recursive: true});
  await assert.rejects(discoverInstallation({home}), /INSTALL_FOLDER_OCCUPIED/);
  await writeFile(join(destination, 'unrelated.txt'), 'preserve');
  await assert.rejects(discoverInstallation({home}), /INSTALL_FOLDER_OCCUPIED/);
  assert.equal(await readFile(join(destination, 'unrelated.txt'), 'utf8'), 'preserve');
});
test('legacy installation is detected and multiple roots require review', async t => {
  const {home, destination} = await fixture(t);
  const old = join(home, 'even-g2-dot'); await payloadAt(old);
  await writeFile(join(old, '.runtime/device-key'), 'test-only');
  assert.equal((await discoverInstallation({home})).existing, true);
  await payloadAt(destination); await writeFile(join(destination, '.runtime/install.json'), '{}');
  await assert.rejects(discoverInstallation({home}), /MULTIPLE_INSTALLATIONS/);
});
test('foreign login services and symlink destinations are protected', async t => {
  const {home, destination} = await fixture(t);
  const agents = join(home, 'Library/LaunchAgents'); await mkdir(agents, {recursive:true});
  await writeFile(join(agents, 'local.even-g2-dot.bridge.plist'), 'fixture');
  await assert.rejects(discoverInstallation({home, execute: async () => JSON.stringify({WorkingDirectory: '/unrelated'})}), /EXISTING_SERVICE_CONFLICT/);
  await rm(agents, {recursive:true});
  await mkdir(join(home,'other')); await mkdir(join(home,'Library/Application Support'), {recursive:true});
  await symlink(join(home,'other'), destination);
  await assert.rejects(discoverInstallation({home}), /INSTALL_FOLDER_OCCUPIED/);
});
test('setup advances through missing dependencies, network, Dot and pairing', () => {
  const ready = {installed:true, dependencies:true, tailscaleConnected:true, tunnelConfigured:true, bridge:true, device:true, tunnel:true, subscribed:true};
  for (const [patch, step] of [[{},'pair'],[{conflict:true},'conflict'],[{installed:false},'install'],[{dependencies:false},'install'],[{tailscaleConnected:false},'network'],[{networkConflict:true},'networkConflict'],[{tunnelConfigured:false},'dot'],[{bridge:false},'start'],[{subscribed:false},'subscribe']]) assert.equal(nextSetupStep({...ready,...patch}), step);
});
