import {readFile,writeFile,rename,unlink,cp,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {ownedJobs,lifecycleState,suspendServices,resumeServices,regularPath} from './app-lifecycle.mjs';
import {run,launchAgent} from './setup.mjs';
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
export async function prepareUpdate(directory,{home=homedir(),execute=run,app=join(home,'Applications/Dot Link.app'),bootstrap=false,...options}={}){
 if(!bootstrap&&!await updateReadiness(directory))return {waiting:true};
 await regularPath(app);
 if((await execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(app,'Contents/Info.plist')]))!=='app.tripsurf.dotlink.mac')throw new Error('UPDATE_APP_INVALID');
 await execute('/usr/bin/codesign',['--verify','--deep','--strict',app]);
 const jobs=await ownedJobs(directory,{home,execute,app,includeUI:true});
 if(!['bridge','device','tunnel'].every(n=>jobs.some(j=>j.name===n)))throw new Error('SERVICE_SETUP_REQUIRED');
 try{await readFile(journalPath(directory));throw new Error('UPDATE_ALREADY_PREPARED');}catch(e){if(e.code!=='ENOENT')throw e;}
 const lifecycle=await lifecycleState(directory),version=await execute('/usr/bin/plutil',['-extract','CFBundleVersion','raw','-o','-',join(app,'Contents/Info.plist')]);
 const originals=[];for(const job of jobs)originals.push({...job,content:await readFile(job.path,'utf8')});
 const backup=join(directory,'.runtime/update-backups',String(Date.now()),'Dot Link.app');await mkdir(join(backup,'..'),{recursive:true,mode:0o700});
 await cp(app,backup,{recursive:true,verbatimSymlinks:true});
 const journal={schema:1,version,stopped:lifecycle.lifecycleStopped,reason:lifecycle.lifecycleReason,originals,backup};
 await writeFile(journalPath(directory),JSON.stringify(journal),{mode:0o600,flag:'wx'});
 if(!bootstrap&&!await updateReadiness(directory)){await unlink(journalPath(directory));return {waiting:true};}
 try{
  await suspendServices(directory,{home,execute,app,...options});
  for(const job of jobs.filter(j=>['bridge','device','tunnel'].includes(j.name))){
   const p=JSON.parse(await execute('/usr/bin/plutil',['-convert','json','-o','-',job.path]));
   await writeFile(job.path,bundledJob(p,job.name,app,directory),{mode:0o600});
  }
  return {prepared:true};
 }catch(e){await finishUpdate(directory,{home,execute,app,rollback:true,...options});throw e;}
}
export async function finishUpdate(directory,{home=homedir(),execute=run,app=join(home,'Applications/Dot Link.app'),rollback=false,verify,...options}={}){
 let journal;try{journal=JSON.parse(await readFile(journalPath(directory),'utf8'));}catch(e){if(e.code==='ENOENT')return {recovered:false};throw e;}
 // Revalidate every destination before restoring a journal; never trust its paths.
 const jobs=await ownedJobs(directory,{home,execute,app,includeUI:true});
 if(journal.schema!==1||!Array.isArray(journal.originals)||journal.originals.some(j=>!jobs.some(p=>p.path===j.path)))throw new Error('UPDATE_JOURNAL_INVALID');
 if(rollback)for(const j of journal.originals)await writeFile(j.path,j.content,{mode:0o600});
 if(!journal.stopped){
  await resumeServices(directory,{home,execute,app,...options});
  const check=verify??(async()=>{try{const h=JSON.parse(await execute(process.execPath,[join(app,'Contents/Resources/payload/scripts/setup-status.mjs'),directory],{timeout:15000}));return h.bridge===true&&h.device===true&&h.tunnel===true;}catch{return false;}});
  let healthy=false;
  for(let attempt=0;attempt<5;attempt++){if(await check()){healthy=true;break;}await (options.wait??(ms=>new Promise(r=>setTimeout(r,ms))))(1000);}
  if(!healthy)throw new Error('UPDATE_RECOVERY_REQUIRED');
 }
 else await save(join(directory,'.runtime/lifecycle.json'),{stopped:true,reason:journal.reason||'pause'});
 await unlink(journalPath(directory));
 return {recovered:true,stopped:journal.stopped};
}
