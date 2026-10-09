import { readFile, writeFile, mkdir, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { run, unloadAgent, activateAgent } from './setup.mjs';
import { ownedService, serviceNames } from './service-management.mjs';

export const uiLabel = 'local.even-g2-dot.setup-ui';
export const lifecycleFile = directory => join(directory, '.runtime/lifecycle.json');
async function saveLifecycle(directory, state) {
  const path=lifecycleFile(directory), temporary=path+`.${process.pid}.tmp`;
  try {
    await writeFile(temporary,JSON.stringify(state),{mode:0o600,flag:'wx'});
    await rename(temporary,path);
  } catch(error) { await unlink(temporary).catch(()=>{});throw error; }
}
export async function lifecycleState(directory) {
  try {
    const s = JSON.parse(await readFile(lifecycleFile(directory), 'utf8'));
    return { lifecycleStopped: s.stopped === true, lifecycleReason: ['pause','quit'].includes(s.reason) ? s.reason : '' };
  } catch (e) {
    if (e.code === 'ENOENT') return { lifecycleStopped: false, lifecycleReason: '' };
    throw new Error('LIFECYCLE_STATE_UNREADABLE');
  }
}
export async function regularPath(path) {
  const s = await lstat(path);
  if (s.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('UNSAFE_INSTALL_PATH');
  return s;
}
export async function ownedJobs(directory, { home = homedir(), execute = run, includeUI = false, app } = {}) {
  const jobs = [];
  for (const name of [...serviceNames, ...(includeUI ? ['setup-ui'] : [])]) {
    const label = `local.even-g2-dot.${name}`, path = join(home, 'Library/LaunchAgents', label + '.plist');
    try { await regularPath(path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let p;
    try { p = JSON.parse(await execute('/usr/bin/plutil', ['-convert','json','-o','-',path])); }
    catch { throw new Error('EXISTING_SERVICE_UNREADABLE'); }
    const valid = name === 'setup-ui'
      ? p.Label === uiLabel && p.WorkingDirectory === join(app, 'Contents') && p.ProgramArguments?.[0] === join(app, 'Contents/MacOS/DotLink')
      : ownedService(p, directory, name, {home});
    if (!valid) throw new Error('EXISTING_SERVICE_CONFLICT');
    jobs.push({ name, label, path });
  }
  return jobs;
}
export async function suspendServices(directory, { reason = 'pause', home = homedir(), execute = run, wait, app = join(home, 'Applications/Dot Link.app'), uid = process.getuid() } = {}) {
  const jobs = await ownedJobs(directory, { home, execute, includeUI: reason === 'quit', app });
  await mkdir(join(directory, '.runtime'), {recursive:true,mode:0o700});
  await saveLifecycle(directory,{stopped:true,reason});
  const domain = `gui/${uid}`;
  // Disable all first, so login/restart cannot revive a service during shutdown.
  for (const job of jobs) await execute('/bin/launchctl', ['disable', `${domain}/${job.label}`]);
  for (const job of [...jobs].reverse().filter(j=>j.name !== 'setup-ui')) {
    const target = `${domain}/${job.label}`;
    let before;
    try { before = await execute('/bin/launchctl',['print',target]); } catch { continue; }
    const pid = before.match(/^\s*pid = (\d+)\s*$/m)?.[1];
    await unloadAgent(target,{execute,wait});
    if (pid) {
      const sleep = wait ?? (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
      let exited = false;
      for (let attempt=0;attempt<60;attempt++) {
        const state = await execute('/bin/ps',['-p',pid,'-o','stat=']).catch(error=>{if(error.code===1)return '';throw error;});
        if (!state.trim() || state.trim().startsWith('Z')) { exited=true;break; }
        await sleep(500);
      }
      if (!exited) throw new Error('SERVICE_STILL_STOPPING');
    }
  }
  return { stopped: true };
}
export async function resumeServices(directory, {home=homedir(),execute=run,wait,app=join(home,'Applications/Dot Link.app'),uid=process.getuid()}={}) {
  const jobs = await ownedJobs(directory,{home,execute,includeUI:true,app});
  if (!['bridge','device','tunnel'].every(name=>jobs.some(j=>j.name===name))) throw new Error('SERVICE_SETUP_REQUIRED');
  const domain=`gui/${uid}`;
  for (const job of jobs) await execute('/bin/launchctl',['enable',`${domain}/${job.label}`]);
  for (const job of jobs.filter(j=>j.name!=='setup-ui')) await activateAgent(domain,job.label,job.path,{execute,wait});
  await saveLifecycle(directory,{stopped:false});
  return { stopped:false };
}

export async function waitForRelay(inspect, {attempts=5,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  let state;
  for(let i=0;i<attempts;i++) {
    state=await inspect();
    if(state.bridge&&state.device&&state.tunnel)return state;
    if(i+1<attempts)await wait(1000);
  }
  return state;
}
