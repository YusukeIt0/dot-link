import { readFile, access, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { run } from './setup.mjs';
import { ownedService } from './service-management.mjs';
const label='local.even-g2-dot.menu';
export function validNotificationProof(proof,now=Date.now()) {
 return proof?.trusted===true && Number.isInteger(proof.pid) && proof.pid>0 &&
  Number.isFinite(proof.updatedAt) && now-proof.updatedAt*1000>=0 && now-proof.updatedAt*1000<120000 &&
  proof.probes?.some(p=>p.registered===true && p.bodyMatched===true && p.selectedAtDetection===true && p.forwarding==='中継受領済み' && Number.isFinite(p.detectedAt) && now-p.detectedAt*1000>=0 && now-p.detectedAt*1000<120000)===true;
}
export async function legacyNotificationState(directory,{home=homedir(),execute=run}={}) {
 const file=join(home,'Library/LaunchAgents',label+'.plist');
 if(!await access(file).then(()=>true,()=>false))return {registered:false};
 const p=JSON.parse(await execute('/usr/bin/plutil',['-convert','json','-o','-',file]));
 if(!ownedService(p,directory,'menu'))throw new Error('NOTIFICATION_SERVICE_CONFLICT');
 return {registered:true,file,executable:p.ProgramArguments[0]};
}
export async function retireLegacyNotifications(directory,{home=homedir(),execute=run,now=Date.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
 const state=await legacyNotificationState(directory,{home,execute});
 if(!state.registered)return {retired:true};
 const proof=JSON.parse(await readFile(join(directory,'.runtime/notification-menu-unified/diagnostics.json'),'utf8'));
 if(!validNotificationProof(proof,now))throw new Error('NOTIFICATION_TEST_REQUIRED');
 const unified=join(home,'Applications/Dot Link.app/Contents/MacOS/DotLink');
 const command=await execute('/bin/ps',['-p',String(proof.pid),'-o','comm=']);
 if(command.trim()!==unified)throw new Error('NOTIFICATION_APP_NOT_INSTALLED');
 const backup=join(directory,'.runtime/notification-migration-backup');await mkdir(backup,{recursive:true,mode:0o700});
 const archived=join(backup,label+'.'+now+'.plist');
 await rename(state.file,archived);
 try {
  const target='gui/'+process.getuid()+'/'+label;
  const loaded=await execute('/bin/launchctl',['print',target]).then(()=>true,()=>false);
  if(loaded)await execute('/bin/launchctl',['bootout',target]);
  const processes=await execute('/bin/ps',['-axo','pid=,comm=']);
  for(const line of processes.split('\n')) {
   const m=line.trim().match(/^(\d+)\s+(.+)$/);if(m&&m[2]===state.executable)await execute('/bin/kill',['-TERM',m[1]]);
  }
  let stillRunning = false;
  for(let attempt=0;attempt<20;attempt++) {
   const active=await execute('/bin/ps',['-axo','pid=,comm=']);
   stillRunning=active.split('\n').some(line=>line.trim().replace(/^\d+\s+/,'')===state.executable);
   if(!stillRunning)break;
   await wait(100);
  }
  if(stillRunning)throw new Error('OLD_APP_STILL_RUNNING');
 }catch(e){
  await rename(archived,state.file);
  const target='gui/'+process.getuid()+'/'+label;
  if(!await execute('/bin/launchctl',['print',target]).then(()=>true,()=>false))await execute('/bin/launchctl',['bootstrap','gui/'+process.getuid(),state.file]).catch(()=>{});
  throw new Error('NOTIFICATION_MIGRATION_FAILED');
 }
 return {retired:true};
}
