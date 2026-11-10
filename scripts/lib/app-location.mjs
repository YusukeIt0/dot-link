import {fork} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {run} from './setup.mjs';
import {regularPath} from './app-lifecycle.mjs';
import {verifyUpdateApp} from './update-storage.mjs';
import {installMenuApp} from './menu-install.mjs';

export const managedAppPath = (home = homedir()) => join(home, 'Applications/Dot Link.app');
const failure = (code, cause) => Object.assign(new Error(code, {cause}), {setupCode: code});
async function buildNumber(app, execute) {
  const value = await execute('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure('APP_LOCATION_REPAIR');
  return Number(value);
}

// Resolve the filesystem location, never Finder's localized display name. No
// services, saved settings, update journals or existing bundles are changed.
export async function ensureAppLocation(source, {home = homedir(), execute = run} = {}) {
  const app = managedAppPath(home);
  let current;
  try { current = await realpath(source); }
  catch (cause) { throw failure('APP_LOCATION_MISSING', cause); }
  if (current === app) {
    await regularPath(app);
    return {app, handoff: false};
  }
  try {
    await verifyUpdateApp(current, execute);
    const sourceBuild = await buildNumber(current, execute);
    let present = true;
    try { await lstat(app); } catch (cause) { if (cause.code === 'ENOENT') present = false; else throw cause; }
    if (!present) {
      await installMenuApp(current, {home, execute, verify: candidate => verifyUpdateApp(candidate, execute)});
    }
    await verifyUpdateApp(app, execute);
    if (await buildNumber(app, execute) < sourceBuild) throw failure('APP_LOCATION_OLDER');
    return {app, handoff: true, source: current};
  } catch (cause) {
    if (cause.message === 'APP_LOCATION_OLDER') throw cause;
    throw failure('APP_LOCATION_REPAIR', cause);
  }
}

// Wait for this exact source host to exit before opening the installed copy:
// opening first loses to the GUI's single-instance guard. Never kill a process
// or touch launchd; an uncertain identity leaves both copies/data intact.
export async function handoffApp({source, hostPID, background = false}, {
  home = homedir(), execute = run, uid = process.getuid(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), ready = () => {},
} = {}) {
  if (!Number.isSafeInteger(hostPID) || hostPID < 2 || typeof source !== 'string' || resolve(source) !== source) throw failure('APP_LOCATION_REPAIR');
  const target = managedAppPath(home);
  const location = await ensureAppLocation(source, {home, execute});
  if (!location.handoff || location.source !== source) throw failure('APP_LOCATION_REPAIR');
  const sourceBuild = await buildNumber(source, execute);
  const executable = join(source, 'Contents/MacOS/DotLink');
  const identity = async () => {
    try { return (await execute('/bin/ps', ['-p', String(hostPID), '-o', 'uid=,lstart=,comm='])).trim(); }
    catch (error) { if (error.code === 1) return ''; throw error; }
  };
  const original = await identity();
  if (!original.startsWith(String(uid) + ' ') || !original.endsWith(' ' + executable)) throw failure('APP_LOCATION_REPAIR');
  ready();
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await identity() !== original) {
      await verifyUpdateApp(target, execute);
      if (await buildNumber(target, execute) < sourceBuild) throw failure('APP_LOCATION_OLDER');
      await execute('/usr/bin/open', [...(background ? ['-g'] : []), target, ...(background ? ['--args', '--background'] : [])]);
      return 'reopened';
    }
    await wait(250);
  }
  throw failure('APP_LOCATION_REPAIR');
}

export async function armAppHandoff(options) {
  const child = fork(fileURLToPath(import.meta.url), ['--handoff', JSON.stringify(options)], {detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.removeAllListeners('error'); child.removeAllListeners('exit'); child.removeAllListeners('message');
      if (error) { child.kill(); reject(failure('APP_LOCATION_REPAIR', error)); }
      else { child.disconnect(); child.unref(); resolve(); }
    };
    const timer = setTimeout(() => finish(new Error('handoff timeout')), 30000);
    child.once('error', finish);
    child.once('exit', () => finish(new Error('handoff exited')));
    child.once('message', value => finish(value === 'ready' ? undefined : new Error('handoff not ready')));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== '--handoff') throw new Error('invalid action');
    await handoffApp(JSON.parse(process.argv[3]), {ready: () => process.send?.('ready')});
  } catch { process.exitCode = 1; }
}
