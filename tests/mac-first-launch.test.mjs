import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/mac-setup.mjs', import.meta.url));
const preload = new URL('./fixtures/mac-first-launch.mjs', import.meta.url).href;

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dot-first-launch-')));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const managed = join(directory, 'Library/Application Support/Dot Link');
  async function run(action = 'update-recover', env = {}) {
    const trace = join(directory, 'trace');
    await writeFile(trace, '');
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', preload, helper, action], {
      env: {...process.env, HOME: directory, ...env}, input: '{}\n', encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(child.error);
    assert.ok(child.stdout.trim(), child.stderr);
    return {value: JSON.parse(child.stdout), status: child.status, trace: (await readFile(trace, 'utf8')).trim().split('\n')};
  }
  return {directory, managed, run};
}

test('first launch and refresh offer Prepare without querying Tailscale or services', async t => {
  const f = await fixture(t);
  for (const action of ['update-recover', 'inspect']) {
    const {value, status, trace} = await f.run(action);
    assert.equal(status, 0);
    assert.equal(value.step, 'install');
    assert.equal(value.installed, false);
    assert.deepEqual(trace, action === 'inspect' ? ['discover'] : ['discover', 'recover']);
  }
  await assert.rejects(access(f.managed), {code:'ENOENT'});
});

test('a stalled discovery returns a shareable error before recovery; retry can proceed', async t => {
  const f = await fixture(t);
  const failed = await f.run('update-recover', {DOTLINK_TEST_STALL_DISCOVERY:'1'});
  assert.equal(failed.status, 1);
  assert.deepEqual(failed.value, {kind:'error', code:'STARTUP_DISCOVERY_TIMEOUT'});
  assert.deepEqual(failed.trace, ['discover']);
  assert.equal((await f.run()).value.step, 'install');
});

test('configured and legacy installations recover before checking network and retain saved data', async t => {
  for (const legacy of [false, true]) {
    const f = await fixture(t);
    const installed = legacy ? join(f.directory, 'Desktop/even-g2-dot') : f.managed;
    const session = 'a'.repeat(64), recovery = 'b'.repeat(64);
    const expiresAt = Date.now() + 3_600_000;
    const saved = {
      'package.json': JSON.stringify({name:'even-g2-dot'}),
      '.runtime/install.json': JSON.stringify({product:'Dot Link', format:1}),
      '.runtime/device-key': 'fixture-key',
      '.runtime/bridge-state.json': '{"messages":[]}',
      '.runtime/lifecycle.json': '{"stopped":true,"reason":"pause"}',
      '.runtime/tunnel.yaml': 'fixture',
      ['.runtime/pairing/sessions/' + session + '.json']: JSON.stringify({origin:'http://127.0.0.1:5555', expiresAt, recoveryHash:recovery}),
      ['.runtime/pairing/recoveries/' + recovery + '.json']: JSON.stringify({currentSession:session, expiresAt}),
    };
    for (const [name, contents] of Object.entries(saved)) {
      const path = join(installed, name);
      await mkdir(dirname(path), {recursive:true});
      await writeFile(path, contents);
    }
    const {value, status, trace} = await f.run();
    assert.equal(status, 0);
    assert.deepEqual(trace, ['discover', 'recover', 'discover', 'network', 'relay']);
    assert.equal(value.installed, true);
    assert.equal(value.existing, legacy);
    assert.equal(value.evenPaired, true);
    assert.equal(value.lifecycleReason, 'pause');
    assert.equal(value.tunnelConfigured, true);
    for (const [name, contents] of Object.entries(saved)) assert.equal(await readFile(join(installed, name),'utf8'), contents);
  }
});

test('an ambiguous existing folder is never presented as a new installation', async t => {
  const f = await fixture(t);
  await mkdir(f.managed, {recursive:true});
  const sentinel = join(f.managed, 'saved.txt');
  await writeFile(sentinel, 'keep');
  const {value, status, trace} = await f.run();
  assert.equal(status, 1);
  assert.deepEqual(value, {kind:'error', code:'INSTALL_FOLDER_OCCUPIED'});
  assert.deepEqual(trace, ['discover']);
  assert.equal(await readFile(sentinel,'utf8'), 'keep');
});

test('a pending update must pass recovery before the setup screen can advance', async t => {
  const f = await fixture(t);
  const runtime = join(f.managed, '.runtime');
  await mkdir(runtime, {recursive:true});
  await writeFile(join(f.managed, 'package.json'), JSON.stringify({name:'even-g2-dot'}));
  await writeFile(join(runtime, 'install.json'), JSON.stringify({product:'Dot Link', format:1}));
  const journal = join(runtime, 'app-update.json');
  const unreadableVersion = JSON.stringify({schema:2, originals:[]});
  await writeFile(journal, unreadableVersion);
  const {value, status, trace} = await f.run();
  assert.equal(status, 1);
  assert.deepEqual(value, {kind:'error', code:'UPDATE_JOURNAL_INVALID'});
  assert.deepEqual(trace, ['discover', 'recover']);
  assert.equal(await readFile(journal, 'utf8'), unreadableVersion);
});
