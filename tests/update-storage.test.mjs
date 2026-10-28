import test from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {withUpdateStorage,createUpdateBackup,pruneUpdateBackups} from '../scripts/lib/update-storage.mjs';

async function fixture(t){
 const home=await realpath(await mkdtemp(join(tmpdir(),'dot-update-storage-')));t.after(()=>rm(home,{recursive:true,force:true}));
 const directory=join(home,'runtime'),runtime=join(directory,'.runtime'),root=join(runtime,'update-backups'),app=join(home,'Dot Link.app');
 await mkdir(root,{recursive:true});await mkdir(join(app,'Contents'),{recursive:true});await writeFile(join(app,'Contents/Info.plist'),'app.tripsurf.dotlink.mac');
 let running='';
 const execute=async(cmd,args)=>{
  if(cmd==='/bin/ps')return running;
  if(cmd==='/usr/bin/plutil')return readFile(args.at(-1),'utf8');
  if(cmd==='/usr/bin/codesign'){assert.equal(await readFile(join(args.at(-1),'Contents/Info.plist'),'utf8'),'app.tripsurf.dotlink.mac');return '';}
  throw new Error('Unexpected command');
 };
 async function backup(n,{managed=false,valid=true}={}){
  const folder=join(root,String(1700000000000+n));await mkdir(join(folder,'Dot Link.app/Contents'),{recursive:true});
  await writeFile(join(folder,'Dot Link.app/Contents/Info.plist'),valid?'app.tripsurf.dotlink.mac':'foreign.app');
  if(managed)await writeFile(join(folder,'backup.json'),JSON.stringify({schema:1,product:'app.tripsurf.dotlink.mac'}));
  return folder;
 }
 return {home,directory,runtime,root,app,execute,backup,running:value=>{running=value;},clean:options=>withUpdateStorage(directory,()=>pruneUpdateBackups(directory,{app,execute,...options}))};
}

test('legacy accumulation is pruned to one usable generation without touching user data',async t=>{
 const f=await fixture(t);
 for(let n=0;n<60;n++)await f.backup(n);
 await writeFile(join(f.runtime,'device-key'),'keep');await writeFile(join(f.runtime,'bridge-state.json'),'history');
 assert.deepEqual(await f.clean(),{removed:59,failed:0});
 assert.deepEqual(await readdir(f.root),['1700000000059']);
 assert.equal(await readFile(join(f.runtime,'device-key'),'utf8'),'keep');assert.equal(await readFile(join(f.runtime,'bridge-state.json'),'utf8'),'history');
 assert.deepEqual(await f.clean(),{removed:0,failed:0});
});

test('a year of frequent updates stays bounded and always retains the latest verified copy',async t=>{
 const f=await fixture(t);
 for(let n=0;n<365;n++){
  await withUpdateStorage(f.directory,async()=>{
   const app=await createUpdateBackup(f.directory);await mkdir(join(app,'Contents'),{recursive:true});await writeFile(join(app,'Contents/Info.plist'),'app.tripsurf.dotlink.mac');
   await pruneUpdateBackups(f.directory,f);
   assert.deepEqual(await readdir(f.root),[dirname(app).split('/').at(-1)]);
  });
 }
});

test('journal and live recovery executables protect backups until recovery has ended',async t=>{
 const f=await fixture(t),old=await f.backup(0);await f.backup(1);
 await writeFile(join(f.runtime,'app-update.json'),JSON.stringify({backup:join(old,'Dot Link.app')}));
 assert.deepEqual(await f.clean(),{deferred:true});assert.equal((await readdir(f.root)).length,2);
 await rm(join(f.runtime,'app-update.json'));f.running(join(old,'Dot Link.app/Contents/Resources/payload/.runtime/bin/node'));
 assert.deepEqual(await f.clean(),{removed:0,failed:0});
 f.running('');assert.deepEqual(await f.clean(),{removed:1,failed:0});
});

test('uncertain process inventory and invalid installed app never authorize deletion',async t=>{
 const f=await fixture(t);await f.backup(0);await f.backup(1);
 await assert.rejects(f.clean({execute:async(cmd,args)=>{if(cmd==='/bin/ps')throw new Error('DENIED');return f.execute(cmd,args);}}),/DENIED/);
 assert.equal((await readdir(f.root)).length,2);
 await writeFile(join(f.app,'Contents/Info.plist'),'foreign.app');await assert.rejects(f.clean(),/UPDATE_APP_INVALID/);assert.equal((await readdir(f.root)).length,2);
});

test('failed or interrupted copies and interrupted removals are reclaimed on retry',async t=>{
 const f=await fixture(t),old=await f.backup(0);await f.backup(1);
 const partial=await createUpdateBackup(f.directory);await mkdir(partial);await writeFile(join(partial,'incomplete'),'partial');
 let failed=false;
 assert.deepEqual(await f.clean({remove:async(path,options)=>{if(path===old&&!failed){failed=true;throw new Error('EACCES');}return rm(path,options);}}),{removed:1,failed:1});
 assert.deepEqual(await f.clean(),{removed:1,failed:0});
 const interrupted=await f.backup(2,{managed:true});await rm(join(interrupted,'Dot Link.app'),{recursive:true});assert.deepEqual(await f.clean(),{removed:1,failed:0});
});

test('failed first-ever backup does not accumulate even without a complete rollback copy',async t=>{
 const f=await fixture(t);
 for(let n=0;n<20;n++){
  const app=await createUpdateBackup(f.directory);await mkdir(app);await writeFile(join(app,'partial'),'incomplete');
  assert.deepEqual(await f.clean(),{removed:1,failed:0});assert.deepEqual(await readdir(f.root),[]);
 }
});

test('unrecognized folders, extra contents, foreign apps and symlinks are preserved',async t=>{
 const f=await fixture(t),foreign=await f.backup(0,{valid:false}),extra=await f.backup(1);await f.backup(9);
 await writeFile(join(extra,'user-file'),'keep');await mkdir(join(f.root,'my-backup'));await writeFile(join(f.root,'my-backup/note'),'keep');
 const external=join(f.home,'external');await mkdir(external);await writeFile(join(external,'sentinel'),'keep');
 await symlink(external,join(f.root,'1700000000002'));await mkdir(join(f.root,'1700000000003'));await symlink(external,join(f.root,'1700000000003/Dot Link.app'));
 assert.deepEqual(await f.clean(),{removed:0,failed:0});
 assert.equal(await readFile(join(external,'sentinel'),'utf8'),'keep');assert.equal(await readFile(join(extra,'user-file'),'utf8'),'keep');assert.ok((await readdir(f.root)).includes(foreign.split('/').at(-1)));
});

test('a symlinked storage root is never traversed',async t=>{
 const f=await fixture(t),external=join(f.home,'outside');await mkdir(external);await writeFile(join(external,'sentinel'),'keep');
 await rm(f.root,{recursive:true});await symlink(external,f.root);
 await assert.rejects(f.clean(),/UNSAFE_INSTALL_PATH/);assert.equal(await readFile(join(external,'sentinel'),'utf8'),'keep');
});

test('concurrent setup helpers serialize and release the lock on failure',async t=>{
 const f=await fixture(t),events=[];let unblock,started;
 const ready=new Promise(resolve=>{started=resolve;}),hold=new Promise(resolve=>{unblock=resolve;});
 const first=withUpdateStorage(f.directory,async()=>{events.push('first');started();await hold;events.push('first-end');});await ready;
 const second=withUpdateStorage(f.directory,async()=>{events.push('second');});unblock();await Promise.all([first,second]);
 assert.deepEqual(events,['first','first-end','second']);
 await assert.rejects(withUpdateStorage(f.directory,async()=>{throw new Error('INTERRUPTED');}),/INTERRUPTED/);
 assert.equal(await withUpdateStorage(f.directory,async()=>42),42);
});

test('persistent lock files are reusable and symlinked locks are rejected',async t=>{
 const f=await fixture(t),lock=join(f.runtime,'update-storage.lock');
 await writeFile(lock,'old contents are not lock ownership');
 assert.equal(await withUpdateStorage(f.directory,async()=>42),42);
 await withUpdateStorage(f.directory,async()=>{
  await assert.rejects(withUpdateStorage(f.directory,async()=>42,{timeout:0}),/UPDATE_ALREADY_PREPARED/);
 });
 await rm(lock);await symlink(join(f.app,'Contents/Info.plist'),lock);
 await assert.rejects(withUpdateStorage(f.directory,async()=>42),/UNSAFE_INSTALL_PATH/);
});

test('OS releases a separate crashed owner and serializes simultaneous recovery attempts',async t=>{
 const f=await fixture(t);
 const module=new URL('../scripts/lib/update-storage.mjs',import.meta.url).href;
 const source=`import {withUpdateStorage} from ${JSON.stringify(module)};await withUpdateStorage(process.argv[1],async()=>{process.stdout.write('ready');await new Promise(()=>{});});`;
 const owner=spawn(process.execPath,['--input-type=module','-e',source,f.directory],{stdio:['ignore','pipe','pipe']});
 t.after(()=>owner.kill('SIGKILL'));
 await once(owner.stdout,'data');
 const exit=once(owner,'exit');owner.kill('SIGKILL');await exit;
 let active=0,peak=0;
 await Promise.all(Array.from({length:5},()=>withUpdateStorage(f.directory,async()=>{
  active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;
 })));
 assert.equal(peak,1);
});
