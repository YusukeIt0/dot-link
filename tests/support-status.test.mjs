import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lifecycleState } from '../scripts/lib/app-lifecycle.mjs';
import { savedSupportFacts } from '../scripts/support-status.mjs';
import { checkSetupHealth } from '../scripts/setup-status.mjs';

async function homeFor(t) {
  const home = await mkdtemp(join(tmpdir(), 'dot-link-support-'));
  t.after(() => rm(home, {recursive:true, force:true}));
  return home;
}

test('fresh, conflicting and unreadable setup are distinct; inspection creates no files', async t => {
  const home = await homeFor(t);
  assert.deepEqual(await savedSupportFacts({home}), {installed:false, step:'install'});
  assert.deepEqual(await readdir(home), []);
  const root = join(home, 'Library/Application Support/Dot Link');
  await mkdir(root, {recursive:true});
  assert.deepEqual(await savedSupportFacts({home}), {step:'conflict'});
  await writeFile(join(root, 'package.json'), '{');
  assert.deepEqual(await savedSupportFacts({home}), {step:'unknown'});
});

test('offline reads preserve an existing paused installation and reobserve pairing and update recovery', async t => {
  const home = await homeFor(t), root = join(home, 'even-g2-dot'), runtime = join(root, '.runtime');
  const sessions = join(runtime, 'pairing/sessions');
  await mkdir(sessions, {recursive:true});
  await writeFile(join(root,'package.json'), JSON.stringify({name:'even-g2-dot'}));
  await writeFile(join(runtime,'install.json'), '{}');
  await writeFile(join(runtime,'lifecycle.json'), '{"stopped":true,"reason":"pause"}');
  await writeFile(join(runtime,'tunnel.yaml'), 'private fixture configuration');
  await writeFile(join(runtime,'update-storage.lock'), '');
  const absent = await savedSupportFacts({home});
  assert.deepEqual(absent, {installed:true, existing:true, lifecycleStopped:true, lifecycleReason:'pause', savedTunnel:true, evenPairingKnown:true, evenPaired:false});
  const session = join(sessions, 'a'.repeat(64) + '.json');
  const saved = JSON.stringify({origin:'http://127.0.0.1:5555',expiresAt:Date.now()+600000});
  await writeFile(session, saved);
  const snapshots = await Promise.all([savedSupportFacts({home}), savedSupportFacts({home})]);
  for (const snapshot of snapshots) assert.deepEqual(snapshot, {...absent, evenPaired:true});
  assert.equal(await readFile(session,'utf8'), saved);
  await writeFile(session, '{');
  assert.equal((await savedSupportFacts({home})).evenPairingKnown, false);
  await writeFile(session, saved);
  assert.deepEqual(await savedSupportFacts({home}), snapshots[0]);
  await writeFile(join(runtime, 'lifecycle.json'), '{"stopped":true,"reason":"quit"}');
  assert.deepEqual(await savedSupportFacts({home}), {...snapshots[0], lifecycleReason:'quit'});
  await writeFile(join(runtime, 'lifecycle.json'), '{}');
  assert.deepEqual(await lifecycleState(root), {lifecycleStopped:false, lifecycleReason:''});
  assert.deepEqual(await lifecycleState(root, {reportUnknown:true}), {});
  assert.equal((await savedSupportFacts({home})).lifecycleStopped, undefined);
  await writeFile(join(runtime, 'app-update.json'), 'private fixture journal');
  assert.deepEqual(await savedSupportFacts({home}), {installed:true, existing:true, step:'updateRecovery'});
  assert.equal(await readFile(join(runtime,'tunnel.yaml'),'utf8'), 'private fixture configuration');
  assert.equal(await readFile(join(runtime,'app-update.json'),'utf8'), 'private fixture journal');
});

test('a failed response, a transport failure and an unavailable observation have different meanings', async () => {
  const options = {read:async () => 'fixture', network:async () => ({state:'ready', origin:'https://fixture.invalid'})};
  let live = false;
  const request = async (url, settings) => {
    assert.equal(settings.redirect, 'error');
    if (url.endsWith('/readyz')) return new Response('startup catalog failed', {status:503});
    if (url.includes('fixture.invalid')) throw new Error('offline', {cause:{code:'ECONNREFUSED'}});
    return live ? Response.json({subscribed:true, previouslySubscribed:true, unrelated:'private fixture'}) : Response.json({});
  };
  const first = await checkSetupHealth('unused', {...options, request});
  assert.equal(first.bridgeCheck,'unknown'); assert.equal(first.subscriptionCheck,'unknown');
  assert.equal(first.tunnelCheck,'failed'); assert.equal(first.tunnelCatalogFailed,true);
  assert.equal(first.deviceCheck,'unreachable');
  live = true;
  const recovered = await checkSetupHealth('unused', {...options, request});
  assert.equal(recovered.subscriptionCheck,'active'); assert.equal(recovered.bridgeCheck,'responded');
  assert.equal(recovered.previouslySubscribed,true);
  assert.ok(!JSON.stringify(recovered).includes('private fixture'));
  const inactive = await checkSetupHealth('unused', {...options, request:async () => Response.json({subscribed:false})});
  assert.equal(inactive.subscriptionCheck, 'inactive');
  const denied = await checkSetupHealth('unused', {...options, request:async () => new Response('', {status:403})});
  assert.equal(denied.bridgeCheck, 'failed'); assert.equal(denied.subscriptionCheck,'unknown');
  const unavailable = await checkSetupHealth('unused', {read:async () => '', request:async () => { throw Error('not available'); }});
  assert.equal(unavailable.bridgeCheck,'unknown'); assert.equal(unavailable.deviceCheck,'unknown');
});
