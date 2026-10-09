import { readFile, readdir, mkdir, mkdtemp, rename, rmdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { run } from './setup.mjs';
import { ownedJobs, regularPath, suspendServices } from './app-lifecycle.mjs';
import { projectIdentity } from './mac-install.mjs';

const dataNames = ['bridge-state.json','notification-state.json','mcp-key','device-key','notification-key',
 'pairing','tunnel.yaml','tunnel-api-key','device-config.json','beta-pairing.txt','beta-pairing.png',
 'latency-bridge.jsonl','latency-device.jsonl','notification-menu-unified','lifecycle.json',
 'bridge-service.log','device-service.log','tunnel-service.log','menu-service.log'];
const has = async p => lstat(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
export async function uninstallPlan(directory, app, {home=homedir(),execute=run}={}) {
  directory=resolve(directory);app=resolve(app);
  await regularPath(app);
  if ((await execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(app,'Contents/Info.plist')])).trim() !== 'app.tripsurf.dotlink.mac') throw new Error('APP_BUNDLE_INVALID');
  const installed=await projectIdentity(directory);
  if (await has(directory) && !installed) throw new Error('INSTALL_FOLDER_OCCUPIED');
  const managed=directory===join(home,'Library/Application Support/Dot Link');
  if (installed && managed) {
    const marker=JSON.parse(await readFile(join(directory,'.runtime/install.json'),'utf8'));
    if(marker.product!=='Dot Link'||marker.format!==1)throw new Error('INSTALL_FOLDER_OCCUPIED');
  }
  const jobs=await ownedJobs(directory,{home,execute,includeUI:true,app});
  const runtime=join(directory,'.runtime');
  if(await has(runtime))await regularPath(runtime);
  const binaries=[];
  if(installed&&!managed)for(const name of ['bin','models','notification-menu/Dot Notification Lab.app']) {
    const p=join(runtime,name);if(await has(p)){await regularPath(p);binaries.push(p);}
  }
  const data=[];
  if(installed&&!managed) {
    const names=await readdir(runtime).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    for(const name of names.filter(n=>dataNames.includes(n)||/^asr-[A-Za-z0-9_-]+$/.test(n))) {
      const p=join(runtime,name);await regularPath(p);data.push(p);
    }
  }
  const roots=[app,...(installed?[directory]:[])];
  const identities=[];
  for(const path of roots){const s=await regularPath(path);identities.push({path,dev:s.dev,ino:s.ino});}
  const registrations=[];
  for(const job of jobs)registrations.push({path:job.path,hash:createHash('sha256').update(await readFile(job.path)).digest('hex')});
  // Do not include changing history contents or credential values in this token.
  const token=createHash('sha256').update(JSON.stringify({identities,registrations})).digest('hex');
  return {token,app,directory,runtime,installed,managed,jobs,binaries,data,
    removes:[app,...(installed&&managed?[directory]:binaries),...jobs.map(j=>j.path)],
    retainsSource:installed&&!managed};
}
export async function uninstallApp(directory,app,{home=homedir(),execute=run,wait,uid=process.getuid(),token,deleteData=false}={}) {
  const plan=await uninstallPlan(directory,app,{home,execute});
  if(typeof token!=='string'||token!==plan.token)throw new Error('UNINSTALL_PLAN_CHANGED');
  if(typeof deleteData!=='boolean')throw new Error('INVALID_UNINSTALL_OPTION');
  // Revalidate before any stop or file mutation; shared services block the whole operation.
  const trashRoot=join(home,'.Trash');await mkdir(trashRoot,{recursive:true,mode:0o700});await regularPath(trashRoot);
  const trash=await mkdtemp(join(trashRoot,'Dot Link-'));
  const moves=[];let savedData;
  async function move(source,destination){await regularPath(source);await rename(source,destination);moves.push([source,destination]);}
  let index=0;
  const trashItem=async source=>{if(await has(source))await move(source,join(trash,`${++index}-${source.split('/').at(-1)}`));};
  try {
    if(plan.installed)await suspendServices(directory,{reason:'quit',home,execute,wait,uid,app});
    else for(const j of plan.jobs)await execute('/bin/launchctl',['disable',`gui/${uid}/${j.label}`]);
    if(plan.installed&&plan.managed&&!deleteData&&await has(plan.runtime)) {
      const savedRoot=join(home,'Library/Application Support/Dot Link Saved Data');
      await mkdir(savedRoot,{recursive:true,mode:0o700});await regularPath(savedRoot);
      savedData=await mkdtemp(join(savedRoot,'saved-'));
      await move(plan.runtime,join(savedData,'.runtime'));
      for(const name of ['bin','models'])await trashItem(join(savedData,'.runtime',name));
    }
    if(plan.installed&&plan.managed)await trashItem(directory);
    else {
      for(const p of plan.binaries)await trashItem(p);
      if(deleteData){for(const p of plan.data)await trashItem(p);await trashItem(join(plan.runtime,'lifecycle.json'));}
      else if(plan.installed)savedData=plan.runtime;
    }
    for(const j of plan.jobs)await trashItem(j.path);
    // The running helper is already loaded. Move its bundle last, then report completion.
    await trashItem(app);
    return {uninstalled:true,trash,savedData:deleteData?undefined:savedData,deleteData};
  } catch(error) {
    let restored=true;
    for(const [from,to] of moves.reverse())try{await rename(to,from);}catch{restored=false;}
    await rmdir(trash).catch(()=>{});
    // Services remain stopped after failure; never silently restart an uninstall attempt.
    throw new Error(restored?'UNINSTALL_FAILED_RESTORED':'UNINSTALL_PARTIAL_REVIEW_REQUIRED');
  }
}
