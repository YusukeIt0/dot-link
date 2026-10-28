import {readFile,writeFile,rename,unlink,cp,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ownedJobs,lifecycleState,suspendServices,resumeServices,regularPath} from './app-lifecycle.mjs';
import {run,launchAgent} from './setup.mjs';
import {serviceNames} from './service-management.mjs';
import {armUpdateExitRecovery} from './update-exit-recovery.mjs';
import {withUpdateStorage,createUpdateBackup,pruneUpdateBackups,verifyUpdateApp} from './update-storage.mjs';
const journalPath=d=>join(d,'.runtime/app-update.json');
async function save(path,value){const temp=path+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,path);}
export function bundledJob(p,name,app,directory){
 const payload=join(app,'Contents/Resources/payload'),bin=join(payload,'.runtime/bin');
 const args=name==='tunnel'?[join(bin,'tunnel-client'),'run','--profile-file',join(directory,'.runtime/tunnel.yaml')]:[join(bin,'node'),join(payload,'server',name==='bridge'?'main.ts':'device-main.ts')];
 return launchAgent(p.Label,args,directory,{...p.EnvironmentVariables,DOT_LINK_APP_RUNTIME:'1',G2_WHISPER_PATH:join(bin,'whisper-cli')});
}
export async function updateReadiness(directory,{now=Date.now()}={}){
 const lifecycle=await lifecycleState(directory);if(lifecycle.lifecycleStopped)return true;
 try{
  const activity=JSON.parse(await readFile(join(directory,'.runtime/update-activity.json'),'utf8'));
  if(!Number.isFinite(activity.at)||activity.at>now||now-activity.at>45000||activity.active!==0||!Number.isFinite(activity.lastClient)||now-activity.lastClient<90000)return false;
  const state=JSON.parse(await readFile(join(directory,'.runtime/bridge-state.json'),'utf8'));
  if(!Array.isArray(state.messages)||state.messages.some(m=>['pending','accepted'].includes(m.status)))return false;
  return true;
 }catch{return false;}
}
// A prepared, never-started installation has no activity heartbeat to wait for.
// Missing service files alone are not proof: reject partial/previous service
// state and check launchd too, so an orphaned running job cannot be overlooked.
async function initialSetupReady(directory,{home,execute,app,uid=process.getuid()}){
 if(directory!==join(home,'Library/Application Support/Dot Link'))return false;
 await regularPath(directory);
 const marker=JSON.parse(await readFile(join(directory,'.runtime/install.json'),'utf8'));
 if(marker.product!=='Dot Link'||marker.format!==1)return false;
 if((await ownedJobs(directory,{home,execute,app,includeUI:true})).length)return false;
 for(const name of ['update-activity.json','bridge-state.json']){
  try{await lstat(join(directory,'.runtime',name));return false;}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 for(const name of [...serviceNames,'setup-ui']){
  try{await execute('/bin/launchctl',['print',`gui/${uid}/local.even-g2-dot.${name}`]);return false;}
  catch(e){if(e.code!==113)throw e;}
 }
 return true;
}
export async function prepareUpdate(directory,options={}){
 return withUpdateStorage(directory,()=>prepareUpdateLocked(directory,options),{timeout:60});
}
async function cleanup(directory,options){
 try{
  const result=await pruneUpdateBackups(directory,options);
  if(result.failed)console.error('Dot Link update cleanup incomplete; retrying on the next start or update.');
 }catch{console.error('Dot Link update cleanup deferred; retrying on the next start or update.');}
}
async function prepareUpdateLocked(directory,{home=homedir(),execute=run,app=join(home,'Applications/Dot Link.app'),bootstrap=false,interrupt=false,hostPID,armRecovery=armUpdateExitRecovery,...options}={}){
 const context={home,execute,app,...options};
 const jobs=await ownedJobs(directory,{home,execute,app,includeUI:true});
 const initialSetup=jobs.length===0&&await initialSetupReady(directory,context);
 if(!initialSetup&&!['bridge','device','tunnel'].every(n=>jobs.some(j=>j.name===n)))throw new Error('SERVICE_SETUP_REQUIRED');
 // An explicitly approved manual update interrupts active work, but still
 // requires a verified backup, recovery journal, and the normal service stop.
 if(!initialSetup&&!bootstrap&&!interrupt&&!await updateReadiness(directory))return {waiting:true};
 await verifyUpdateApp(app,execute);
 try{await readFile(journalPath(directory));throw new Error('UPDATE_ALREADY_PREPARED');}catch(e){if(e.code!=='ENOENT')throw e;}
 const lifecycle=await lifecycleState(directory),version=await execute('/usr/bin/plutil',['-extract','CFBundleVersion','raw','-o','-',join(app,'Contents/Info.plist')]);
 const originals=[];for(const job of jobs)originals.push({...job,content:await readFile(job.path,'utf8')});
 await cleanup(directory,{app,execute});
 const backup=await createUpdateBackup(directory);
 try{await cp(app,backup,{recursive:true,verbatimSymlinks:true});await verifyUpdateApp(backup,execute);}
 catch(error){await cleanup(directory,{app,execute});throw error;}
 const journal={schema:1,version,stopped:lifecycle.lifecycleStopped,reason:lifecycle.lifecycleReason,originals,backup,...(initialSetup?{initialSetup:true}:{})};
 await writeFile(journalPath(directory),JSON.stringify(journal),{mode:0o600,flag:'wx'});
 try{
  if(initialSetup){
   if(!await initialSetupReady(directory,context))throw new Error('UPDATE_SETUP_CHANGED');
   if(hostPID!==undefined)await armRecovery(directory,{app,backup,hostPID,uid:options.uid});
   return {prepared:true};
  }
  if(!bootstrap&&!interrupt&&!await updateReadiness(directory)){await unlink(journalPath(directory));await cleanup(directory,{app,execute});return {waiting:true};}
  await suspendServices(directory,{home,execute,app,...options});
  for(const job of jobs.filter(j=>['bridge','device','tunnel'].includes(j.name))){
   const p=JSON.parse(await execute('/usr/bin/plutil',['-convert','json','-o','-',job.path]));
   await writeFile(job.path,bundledJob(p,job.name,app,directory),{mode:0o600});
  }
  if(hostPID!==undefined)await armRecovery(directory,{app,backup,hostPID,uid:options.uid});
  return {prepared:true};
 }catch(e){
  try{await finishUpdateLocked(directory,{home,execute,app,rollback:true,...options});}
  catch{throw new Error('UPDATE_RECOVERY_REQUIRED');}
  throw e;
 }
}
function launchCleanup(directory,app){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./update-cleanup-worker.mjs',import.meta.url)),directory,...(app?[app]:[])],{detached:true,stdio:'ignore'});
 child.on('error',()=>{});child.unref();
}
export async function finishUpdate(directory,options={}){
 try{await regularPath(join(directory,'.runtime'));}catch(e){if(e.code==='ENOENT')return {recovered:false};throw e;}
 // A healthy launch with no recovery journal must not wait behind a previous
 // background sweep. A concurrently created journal belongs to its preparer.
 if(options.backgroundCleanup){
  try{await lstat(journalPath(directory));}catch(e){
   if(e.code!=='ENOENT')throw e;
   (options.launchCleanup??launchCleanup)(directory,options.app);return {recovered:false};
  }
 }
 const result=await withUpdateStorage(directory,()=>finishUpdateLocked(directory,options),{timeout:options.cleanupOnly?0:10});
 if(options.backgroundCleanup){
  // A one-shot child does not hold the GUI helper's stdout pipe open. Its own
  // lock and health/journal checks make it safe to race a later user action.
  (options.launchCleanup??launchCleanup)(directory,options.app);
 }
 return result;
}
async function finishUpdateLocked(directory,{home=homedir(),execute=run,app=join(home,'Applications/Dot Link.app'),rollback=false,verify,backgroundCleanup=false,cleanupOnly=false,...options}={}){
 const check=verify??(async()=>{try{const h=JSON.parse(await execute(process.execPath,[join(app,'Contents/Resources/payload/scripts/setup-status.mjs'),directory],{timeout:15000}));return h.bridge===true&&h.device===true&&h.tunnel===true;}catch{return false;}});
 let journal;try{journal=JSON.parse(await readFile(journalPath(directory),'utf8'));}catch(e){
  if(e.code!=='ENOENT')throw e;
  // Startup and later update attempts retry cleanup, even if the last cleanup
  // was interrupted after its recovery journal had already been removed.
  if(!backgroundCleanup&&((await lifecycleState(directory)).lifecycleStopped||await check()))await cleanup(directory,{app,execute});
  return {recovered:false};
 }
 // A background sweep must never consume a journal created since it started.
 if(cleanupOnly)return {recovered:false};
 // A live host has taken recovery back from Sparkle. Disarm the exit watcher
 // even if ownership/health checks fail, so a later explicit Quit is respected.
 if(rollback&&journal.schema===1){journal.exitRecoveryCancelled=true;await save(journalPath(directory),journal);}
 // Revalidate every destination before restoring a journal; never trust its paths.
 const jobs=await ownedJobs(directory,{home,execute,app,includeUI:true});
 if(journal.schema!==1||!Array.isArray(journal.originals)||journal.originals.some(j=>!jobs.some(p=>p.path===j.path)))throw new Error('UPDATE_JOURNAL_INVALID');
 if(journal.initialSetup===true){
  if(journal.originals.length!==0||!await initialSetupReady(directory,{home,execute,app,...options}))throw new Error('UPDATE_SETUP_CHANGED');
  await unlink(journalPath(directory));
  if(!backgroundCleanup)await cleanup(directory,{app,execute});
  return {recovered:true,stopped:journal.stopped,initialSetup:true};
 }
 if(rollback)for(const j of journal.originals)await writeFile(j.path,j.content,{mode:0o600});
 if(!journal.stopped){
  await resumeServices(directory,{home,execute,app,...options});
  let healthy=false;
  for(let attempt=0;attempt<5;attempt++){if(await check()){healthy=true;break;}await (options.wait??(ms=>new Promise(r=>setTimeout(r,ms))))(1000);}
  if(!healthy)throw new Error('UPDATE_RECOVERY_REQUIRED');
 }
 else await save(join(directory,'.runtime/lifecycle.json'),{stopped:true,reason:journal.reason||'pause'});
 await unlink(journalPath(directory));
 if(!backgroundCleanup)await cleanup(directory,{app,execute});
 return {recovered:true,stopped:journal.stopped};
}
