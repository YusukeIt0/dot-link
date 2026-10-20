import {fork} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from './setup.mjs';
import {regularPath} from './app-lifecycle.mjs';

const bundleID='app.tripsurf.dotlink.mac';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const journalPath=directory=>join(directory,'.runtime/app-update.json');

async function processIdentity(pid,execute){
 if(!Number.isSafeInteger(pid)||pid<2)throw new Error('UPDATE_WATCH_HOST_INVALID');
 try{return await execute('/bin/ps',['-p',String(pid),'-o','lstart=,comm=']);}
 catch(error){if(error.code===1)return '';throw error;}
}
async function installerPresent(uid,execute){
 let present=false;
 for(const suffix of ['updater','progress']){
  try{await execute('/bin/launchctl',['print',`gui/${uid}/${bundleID}-sparkle-${suffix}`]);present=true;}
  catch(error){if(error.code!==113)throw error;}
 }
 return present;
}

// Run from the verified backup: the installed bundle can disappear during
// replacement. This process only reopens the app; startup owns journal recovery.
export async function watchUpdateExit({directory,app,backup,hostPID,uid=process.getuid()},{
 execute=run,wait=sleep,now=Date.now,timeout=15*60*1000,ready=()=>{},
 readJournal=async()=>JSON.parse(await readFile(journalPath(directory),'utf8')),
 identity=pid=>processIdentity(pid,execute),
 installing=()=>installerPresent(uid,execute),
 appRunning=async()=>(await execute('/bin/ps',['-axo','comm='])).split('\n').some(p=>p.trim()===join(app,'Contents/MacOS/DotLink')),
 reopen=async()=>{
  await regularPath(app);
  if(await execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(app,'Contents/Info.plist')])!==bundleID)throw new Error('UPDATE_APP_INVALID');
  await execute('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  // LaunchServices keeps a concurrent normal relaunch a single app instance.
  // --background suppresses our startup window. Do not use open -j: hiding the
  // application also hides later user-requested modal update confirmations.
  await execute('/usr/bin/open',['-g',app,'--args','--background']);
 }
}={}){
 const original=await identity(hostPID);
 if(!original.endsWith(join(app,'Contents/MacOS/DotLink'))||!await installing())throw new Error('UPDATE_WATCH_NOT_READY');
 const current=async()=>{
  try{const journal=await readJournal();return journal.backup===backup&&journal.exitRecoveryCancelled!==true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
 };
 if(!await current())throw new Error('UPDATE_WATCH_JOURNAL_CHANGED');
 ready();
 const deadline=now()+timeout;
 while(now()<deadline){
  if(!await current())return 'recovered';
  if(await identity(hostPID)!==original&&!await installing()){
   // Let Sparkle's successful relaunch settle before considering a fallback.
   await wait(3000);
   if(!await current())return 'recovered';
   if(await installing())continue;
   if(await appRunning())return 'app-running';
   await reopen();
   return 'reopened';
  }
  await wait(1000);
 }
 return 'expired'; // Preserve the journal; never race a stuck installer.
}

export async function armUpdateExitRecovery(directory,{app,backup,hostPID,uid=process.getuid()}){
 const payload=join(backup,'Contents/Resources/payload');
 const child=fork(join(payload,'scripts/lib/update-exit-recovery.mjs'),
  ['--watch',JSON.stringify({directory,app,backup,hostPID,uid})],
  {execPath:join(payload,'.runtime/bin/node'),detached:true,stdio:['ignore','ignore','ignore','ipc']});
 await new Promise((resolve,reject)=>{
  let settled=false;
  const finish=error=>{
   if(settled)return;settled=true;clearTimeout(timer);
   child.removeAllListeners('error');child.removeAllListeners('exit');child.removeAllListeners('message');
   if(error){child.kill();reject(new Error('UPDATE_WATCH_NOT_READY'));}
   else{child.disconnect();child.unref();resolve();}
  };
  const timer=setTimeout(()=>finish(new Error('timeout')),15000);
  child.once('error',finish);child.once('exit',()=>finish(new Error('exit')));
  child.on('message',message=>finish(message==='ready'?undefined:new Error('not ready')));
 });
}

if(process.argv[1]===fileURLToPath(import.meta.url)&&process.argv[2]==='--watch'){
 try{
  await watchUpdateExit(JSON.parse(process.argv[3]),{ready:()=>process.send?.('ready')});
 }catch{process.exitCode=1;}
}
