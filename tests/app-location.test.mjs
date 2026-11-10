import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureAppLocation, handoffApp, managedAppPath, runAppHandoff, consumeHandoffFailure, isManagedApp} from '../scripts/lib/app-location.mjs';
import {verifyUpdateApp} from '../scripts/lib/update-storage.mjs';
import {installMenuApp} from '../scripts/lib/menu-install.mjs';

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dot-location-')));
  t.after(() => rm(home, {recursive: true, force: true}));
  const source = join(home, 'アプリケーション/Dot Link.app'), app = managedAppPath(home);
  async function bundle(path, build = 117, extra = {}) {
    await mkdir(join(path, 'Contents/MacOS'), {recursive: true});
    await writeFile(join(path, 'Contents/Info.plist'), JSON.stringify({CFBundleIdentifier: 'app.tripsurf.dotlink.mac', CFBundleVersion: String(build), ...extra}));
    await writeFile(join(path, 'Contents/MacOS/DotLink'), 'fixture executable');
  }
  await bundle(source);
  const runtime = join(home, 'Library/Application Support/Dot Link/.runtime');
  await mkdir(runtime, {recursive: true});
  const saved = {'tunnel-api-key': 'synthetic-key', 'bridge-state.json': 'synthetic-history', 'app-update.json': 'synthetic-journal', 'lifecycle.json': '{"stopped":true,"reason":"pause"}'};
  for (const [name, content] of Object.entries(saved)) await writeFile(join(runtime, name), content);
  const calls = [];
  const execute = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === '/usr/bin/plutil') return JSON.parse(await readFile(args.at(-1), 'utf8'))[args[1]];
    if (cmd === '/usr/bin/codesign') {
      if (JSON.parse(await readFile(join(args.at(-1), 'Contents/Info.plist'), 'utf8')).damaged) throw new Error('signature invalid');
      return '';
    }
    throw new Error('Unexpected process execution');
  };
  const preserved = async () => {
    for (const [name, content] of Object.entries(saved)) assert.equal(await readFile(join(runtime, name), 'utf8'), content);
    assert.ok(!calls.some(([cmd]) => cmd === '/bin/launchctl'));
  };
  return {home, source, app, bundle, execute, calls, preserved};
}

test('non-English source restores missing managed app and leaves settings, journal and pause unchanged', async t => {
  const f = await fixture(t);
  assert.deepEqual(await ensureAppLocation(f.source, f), {app: f.app, source: f.source, handoff: true});
  assert.equal(await readFile(join(f.app, 'Contents/MacOS/DotLink'), 'utf8'), 'fixture executable');
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Dot Link.app']);
  assert.ok(f.calls.some(([cmd, ...args]) => cmd === '/usr/bin/codesign' && args.at(-1).includes('.Dot-Link-app-')));
  await f.preserved();
});

test('normal canonical startup needs no copy or signature process; an alias to it has the same identity', async t => {
  const f = await fixture(t); await f.bundle(f.app);
  const alias = join(f.home, 'alias.app'); await symlink(f.app, alias);
  assert.deepEqual(await ensureAppLocation(f.app, f), {app: f.app, handoff: false});
  assert.deepEqual(await ensureAppLocation(alias, f), {app: f.app, handoff: false});
  assert.equal(f.calls.length, 0); await f.preserved();
});

test('home alias is the same installed app, including the failure-receipt identity check', async t => {
  const f = await fixture(t); await f.bundle(f.app);
  const alias = f.home + '-alias'; await symlink(f.home, alias);
  t.after(() => rm(alias, {force:true}));
  assert.equal(await isManagedApp(f.app, alias), true);
  assert.equal((await ensureAppLocation(f.app, {...f, home:alias})).handoff, false);
  assert.equal(f.calls.length, 0); await f.preserved();
});

test('case-insensitive Applications spelling does not cause a handoff to itself', async t => {
  const f = await fixture(t); await f.bundle(f.app);
  await rename(join(f.home, 'Applications'), join(f.home, 'applications'));
  try { await realpath(f.app); } catch (error) { if(error.code === 'ENOENT') { t.skip('case-sensitive filesystem'); return; } throw error; }
  assert.equal(await isManagedApp(f.app, f.home), true);
  assert.equal((await ensureAppLocation(f.app, f)).handoff, false);
  assert.equal(f.calls.length, 0); await f.preserved();
});

for (const build of [117, 118]) test(`external copy hands off to equal/newer managed build ${build} without replacing it`, async t => {
  const f = await fixture(t); await f.bundle(f.app, build);
  const before = await readFile(join(f.app, 'Contents/Info.plist'), 'utf8');
  assert.equal((await ensureAppLocation(f.source, f)).handoff, true);
  assert.equal(await readFile(join(f.app, 'Contents/Info.plist'), 'utf8'), before);
  await f.preserved();
});

for (const [build, extra, code] of [[116, {}, 'APP_LOCATION_OLDER'], [118, {damaged: true}, 'APP_LOCATION_REPAIR'], [118, {CFBundleIdentifier: 'other.app'}, 'APP_LOCATION_REPAIR']]) {
  test(`existing canonical copy is preserved: ${JSON.stringify([build, extra])}`, async t => {
    const f = await fixture(t); await f.bundle(f.app, build, extra);
    const before = await readFile(join(f.app, 'Contents/Info.plist'), 'utf8');
    await assert.rejects(ensureAppLocation(f.source, f), {message: code});
    assert.equal(await readFile(join(f.app, 'Contents/Info.plist'), 'utf8'), before);
    await f.preserved();
  });
}

test('damaged source is never installed and a redirected Applications directory is rejected', async t => {
  const f = await fixture(t); await f.bundle(f.source, 117, {damaged: true});
  await assert.rejects(ensureAppLocation(f.source, f), /APP_LOCATION_REPAIR/);
  await assert.rejects(readFile(join(f.app, 'Contents/Info.plist')), {code: 'ENOENT'});
  await f.bundle(f.source); const other = join(f.home, 'other'); await mkdir(other);
  await symlink(other, join(f.home, 'Applications'));
  await assert.rejects(ensureAppLocation(f.source, f), /APP_LOCATION_REPAIR/);
  assert.deepEqual(await readdir(other), []); await f.preserved();
});

test('a concurrently appearing destination is preserved and staging is cleaned', async t => {
  const f = await fixture(t);
  await assert.rejects(installMenuApp(f.source, {...f, verify: async () => f.bundle(f.app, 118)}), /APP_BUNDLE_CONFLICT/);
  assert.equal(JSON.parse(await readFile(join(f.app, 'Contents/Info.plist'))).CFBundleVersion, '118');
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Dot Link.app']);
});

test('verification failure cleans the candidate without exposing a partial installed app', async t => {
  const f = await fixture(t);
  await assert.rejects(installMenuApp(f.source, {...f, verify: async () => {throw new Error('invalid copy');}}), /invalid copy/);
  assert.deepEqual(await readdir(join(f.home, 'Applications')), []);
});

test('missing managed app has a structured location error for recovery', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyUpdateApp(f.app, f.execute), error => error.message === 'APP_LOCATION_MISSING' && error.setupCode === 'APP_LOCATION_MISSING');
  await f.preserved();
});

test('handoff waits for exact source host exit, then opens foreground installed app without changing relay state', async t => {
  const f = await fixture(t); let reads = 0, ready = false, waits = 0;
  const original = `501 Mon Nov 10 12:00:00 2026 ${f.source}/Contents/MacOS/DotLink`;
  const execute = async (cmd, args) => {
    if (cmd === '/bin/ps') { reads++; if (reads <= 2) return original; throw Object.assign(new Error('gone'), {code: 1}); }
    if (cmd === '/usr/bin/open') { assert.equal(ready, true); assert.equal(waits, 1); assert.deepEqual(args, [f.app]); return ''; }
    return f.execute(cmd, args);
  };
  assert.equal(await handoffApp({source: f.source, hostPID: 1234}, {...f, execute, uid: 501, wait: async () => {waits++;}, ready: () => {ready = true;}}), 'reopened');
  await f.preserved();
});

test('handoff preserves background intent and revalidates target after host exit', async t => {
  const f = await fixture(t); let reads = 0, opens = 0;
  const execute = async (cmd, args) => {
    if (cmd === '/bin/ps') return ++reads === 1 ? `501 original ${f.source}/Contents/MacOS/DotLink` : '';
    if (cmd === '/usr/bin/open') { opens++; assert.deepEqual(args, ['-g', f.app, '--args', '--background']); return ''; }
    return f.execute(cmd, args);
  };
  await handoffApp({source: f.source, hostPID: 1234, background: true}, {...f, execute, uid: 501});
  assert.equal(opens, 1);
  reads = 0;
  const changedTarget = async (cmd, args) => {
    if (cmd === '/bin/ps') {
      if (++reads === 1) return `501 original ${f.source}/Contents/MacOS/DotLink`;
      await f.bundle(f.app, 117, {damaged: true}); return '';
    }
    if (cmd === '/usr/bin/open') { opens++; throw new Error('must not open'); }
    return f.execute(cmd, args);
  };
  await assert.rejects(handoffApp({source: f.source, hostPID: 1234}, {...f, execute: changedTarget, uid: 501}), /UPDATE_APP_INVALID/);
  assert.equal(opens, 1);
});

test('handoff refuses a foreign host and never signals a host that stays alive', async t => {
  const f = await fixture(t); let waits = 0;
  await assert.rejects(handoffApp({source: f.source, hostPID: 1234}, {...f, uid: 501, execute: async (cmd, args) => cmd === '/bin/ps' ? '502 other /other/app' : f.execute(cmd, args)}), /APP_LOCATION_REPAIR/);
  const execute = async (cmd, args) => cmd === '/bin/ps' ? `501 original ${f.source}/Contents/MacOS/DotLink` : f.execute(cmd, args);
  await assert.rejects(handoffApp({source: f.source, hostPID: 1234}, {...f, execute, uid: 501, wait: async () => {waits++;}}), /APP_LOCATION_REPAIR/);
  assert.equal(waits, 80); await f.preserved();
});

test('post-exit open failure reopens source once with guidance and consumes a bounded receipt', async t => {
  const f = await fixture(t); let reads = 0; const opens = [];
  const now = Date.now();
  const execute = async (cmd, args) => {
    if (cmd === '/bin/ps') return ++reads === 1 ? `501 original ${f.source}/Contents/MacOS/DotLink` : '';
    if (cmd === '/usr/bin/open') {
      opens.push(args);
      if (args[0] === f.app) throw new Error('launch failed');
      return '';
    }
    return f.execute(cmd, args);
  };
  assert.equal(await runAppHandoff({source:f.source,hostPID:1234},{...f,execute,uid:501,now}), 'failed');
  assert.deepEqual(opens, [[f.app],[f.source,'--args','--app-location-failed']]);
  assert.equal(await consumeHandoffFailure({home:f.home,now:now+1}), 'APP_LOCATION_REPAIR');
  assert.equal(await consumeHandoffFailure({home:f.home,now:now+2}), undefined);
  await f.preserved();
});

test('failed fallback leaves a receipt for manual launch, expires it, and pre-arm failures do not reopen anything', async t => {
  const f = await fixture(t); let reads=0, opens=0; const now=Date.now();
  const execute=async(cmd,args)=>{
    if(cmd==='/bin/ps')return ++reads===1?`501 original ${f.source}/Contents/MacOS/DotLink`:'';
    if(cmd==='/usr/bin/open'){opens++;throw new Error('no GUI session');}
    return f.execute(cmd,args);
  };
  assert.equal(await runAppHandoff({source:f.source,hostPID:1234},{...f,execute,uid:501,now}), 'failed');
  assert.equal(opens,2);
  assert.equal(await consumeHandoffFailure({home:f.home,now:now+300001}),undefined);
  await assert.rejects(runAppHandoff({source:f.source,hostPID:0},{...f,execute,uid:501}),/APP_LOCATION_REPAIR/);
  assert.equal(opens,2);
  assert.equal(await consumeHandoffFailure({home:f.home,now}),undefined);
});
