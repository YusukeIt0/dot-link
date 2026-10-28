import {open,readFile,writeFile,lstat,rename,readdir,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {regularPath} from './app-lifecycle.mjs';
import {run} from './setup.mjs';

const bundleID='app.tripsurf.dotlink.mac';
const generation=/^\d{13}$/;
const receiptName='backup.json';
const removing=/^\d{13}\.removing$/;
async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

// Keep one inode permanently. OS advisory locks are released on process exit;
// never unlink/reclaim a PID lock, which can race another recovering helper.
export async function withUpdateStorage(directory,operation,{timeout=10}={}){
 const runtime=join(directory,'.runtime');await regularPath(runtime);
 const path=join(runtime,'update-storage.lock');
 try{const file=await open(path,'wx',0o600);await file.close();}catch(e){if(e.code!=='EEXIST')throw e;}
 await regularPath(path);
 const holder="process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
 const command=process.platform==='darwin'?'/usr/bin/lockf':'flock';
 const args=process.platform==='darwin'?['-k','-s','-t',String(timeout),path]:['-x','-w',String(timeout),path];
 const child=spawn(command,[...args,process.execPath,'-e',holder],{stdio:['pipe','pipe','ignore']});
 child.stdin.on('error',()=>{});
 let acquired=false;
 const ended=new Promise(resolve=>{child.once('error',resolve);child.once('exit',resolve);});
 try{
  await new Promise((resolve,reject)=>{
   child.once('error',reject);
   child.once('exit',()=>{if(!acquired)reject(new Error('UPDATE_ALREADY_PREPARED'));});
   child.stdout.once('data',()=>{acquired=true;resolve();});
  });
  return await operation();
 }finally{child.stdin.end();await ended;}
}

export async function verifyUpdateApp(app,execute=run){
 if(!(await regularPath(app)).isDirectory())throw new Error('UPDATE_APP_INVALID');
 await regularPath(join(app,'Contents/Info.plist'));
 if(await execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(app,'Contents/Info.plist')])!==bundleID)throw new Error('UPDATE_APP_INVALID');
 await execute('/usr/bin/codesign',['--verify','--deep','--strict',app]);
}

export async function createUpdateBackup(directory){
 const root=join(directory,'.runtime/update-backups');
 await mkdir(root,{recursive:true,mode:0o700});await regularPath(root);
 // Monotonic even for rapid retries or a clock adjustment. The lock prevents
 // concurrent creators from picking the same generation.
 const previous=(await readdir(root)).filter(name=>generation.test(name)).map(Number);
 const next=Math.max(Date.now(),...previous.map(n=>n+1));
 const folder=join(root,String(next));await mkdir(folder,{mode:0o700});
 // The receipt is outside the signed app. It also identifies interrupted copies.
 await writeFile(join(folder,receiptName),JSON.stringify({schema:1,product:bundleID}),{mode:0o600,flag:'wx'});
 return join(folder,'Dot Link.app');
}

// Called only while holding the storage lock. No arbitrary cache or user files
// are traversed. In particular, Sparkle owns its own download/staging cleanup.
export async function pruneUpdateBackups(directory,{app,execute=run,remove=rm}={}){
 const root=join(directory,'.runtime/update-backups'),journal=join(directory,'.runtime/app-update.json');
 if(await exists(journal))return {deferred:true};
 await verifyUpdateApp(app,execute);
 try{await regularPath(root);}catch(e){if(e.code==='ENOENT')return {removed:0};throw e;}
 const processes=(await execute('/bin/ps',['-axo','comm='])).split('\n').map(s=>s.trim());
 const all=await readdir(root);
 const entries=all.filter(name=>generation.test(name)).sort().reverse();
 const candidates=all.filter(name=>removing.test(name)).map(name=>join(root,name));let keep;
 for(const name of entries){
  const folder=join(root,name),app=join(folder,'Dot Link.app');
  try{
   if(!(await regularPath(folder)).isDirectory())continue;
   const names=await readdir(folder);
   if(names.some(n=>!['Dot Link.app',receiptName].includes(n)))continue;
   let managed=false;
   if(names.includes(receiptName)){
    await regularPath(join(folder,receiptName));
    const receipt=JSON.parse(await readFile(join(folder,receiptName),'utf8'));
    managed=receipt.schema===1&&receipt.product===bundleID;
    if(!managed)continue;
   }
   let verified=false;
   if(names.includes('Dot Link.app')){
    if(!(await regularPath(app)).isDirectory())continue;
    try{await verifyUpdateApp(app,execute);verified=true;}catch{if(!managed)continue;}
   }
   // Legacy entries must identify a genuine app; empty interrupted removals
   // are harmless. A managed partial copy is disposable after recovery ends.
   if(!verified&&!managed&&names.length)continue;
   if(verified&&!keep)keep=folder;
   candidates.push(folder);
  }catch{/* Unreadable/unrecognized entries are not deletion authority. */}
 }
 // A failed first copy may leave no verified backup. The verified installed
 // app above is still intact; only recognized partial copies may be removed.
 let removed=0,failed=0;
 for(const folder of candidates){
  if(folder===keep||processes.some(p=>p.startsWith(folder+'/')))continue;
  try{
   if(await exists(journal))return {removed,failed,deferred:true};
   await regularPath(root);if(!(await regularPath(folder)).isDirectory())continue;
   // Atomic rename records deletion intent outside the recursively removed
   // contents, so even a partial app/receipt removal remains reclaimable.
   const target=folder.endsWith('.removing')?folder:folder+'.removing';
   if(target!==folder){if(await exists(target))throw new Error('UPDATE_CLEANUP_COLLISION');await rename(folder,target);}
   await remove(target,{recursive:true});removed++;
  }catch{failed++;}
 }
 return {removed,failed};
}
