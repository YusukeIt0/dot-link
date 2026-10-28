import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from '../scripts/lib/setup.mjs';
import {withUpdateStorage} from '../scripts/lib/update-storage.mjs';
import {ownedService} from '../scripts/lib/service-management.mjs';
import {prepareUpdate,finishUpdate,updateReadiness} from '../scripts/lib/app-update.mjs';
async function fixture(t,{initialSetup=false}={}){
 const home=await realpath(await mkdtemp(join(tmpdir(),'dot-update-')));t.after(()=>rm(home,{recursive:true,force:true}));
 const directory=join(home,initialSetup?'Library/Application Support/Dot Link':'even-g2-dot'),runtime=join(directory,'.runtime'),app=join(home,'Applications/Dot Link.app'),agents=join(home,'Library/LaunchAgents');
 for(const p of [runtime,join(app,'Contents'),agents])await mkdir(p,{recursive:true});
 await writeFile(join(app,'Contents/Info.plist'),'fixture');
 if(initialSetup)await writeFile(join(runtime,'install.json'),JSON.stringify({product:'Dot Link',format:1}));
 else await writeFile(join(runtime,'bridge-state.json'),JSON.stringify({messages:[]}));
 const plists={};for(const name of initialSetup?[]:['bridge','device','tunnel','setup-ui']){
  const label='local.even-g2-dot.'+name,p={Label:label,WorkingDirectory:name==='setup-ui'?join(app,'Contents'):directory,ProgramArguments:name==='setup-ui'?[join(app,'Contents/MacOS/DotLink')]:name==='tunnel'?['tunnel','run','--profile-file',join(runtime,'tunnel.yaml')]:['node',join(directory,'server',name==='bridge'?'main.ts':'device-main.ts')],EnvironmentVariables:{G2_DEVICE_ORIGIN:'https://example.ts.net'}};
  plists[name]=join(agents,label+'.plist');await writeFile(plists[name],JSON.stringify(p));
 }
 const loaded=new Set(Object.keys(plists)),disabled=new Set(),calls=[];
 const execute=async(cmd,args)=>{
  calls.push([cmd,...args]);
  if(cmd==='/usr/bin/codesign')return '';
  if(cmd==='/bin/ps'&&args[0]==='-axo')return '';
  if(cmd==='/usr/bin/plutil'){if(args[0]==='-extract')return args[1]==='CFBundleVersion'?'1':'app.tripsurf.dotlink.mac';return run(cmd,args);}
  if(cmd==='/bin/launchctl'){const name=args[1].split('.').at(-1);if(args[0]==='print'){if(!loaded.has(name))throw Object.assign(new Error('not loaded'),{code:113});return 'state = running';}if(args[0]==='disable')disabled.add(name);if(args[0]==='enable')disabled.delete(name);if(args[0]==='bootout')loaded.delete(name);if(args[0]==='bootstrap'){const p=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',args[2]]));loaded.add(p.Label.split('.').at(-1));}return '';}
  throw new Error('unexpected command');
 };
 return {home,directory,runtime,app,plists,loaded,disabled,calls,execute,uid:501,wait:async()=>{},verify:async()=>true};
}
test('unknown, stale, active clients and pending conversations block automatic replacement',async t=>{
 const f=await fixture(t),now=Date.now(),activity=join(f.runtime,'update-activity.json');
 assert.equal(await updateReadiness(f.directory),false);
 for(const patch of [{at:now-46000},{active:1},{lastClient:now},{at:now+10000}]){await writeFile(activity,JSON.stringify({at:now,lastClient:now-100000,active:0,...patch}));assert.equal(await updateReadiness(f.directory,{now}),false);}
 await writeFile(activity,JSON.stringify({at:now,lastClient:now-100000,active:0}));assert.equal(await updateReadiness(f.directory,{now}),true);
 await writeFile(join(f.runtime,'bridge-state.json'),JSON.stringify({messages:[{status:'accepted'}]}));assert.equal(await updateReadiness(f.directory,{now}),false);
 await writeFile(join(f.runtime,'lifecycle.json'),JSON.stringify({stopped:true,reason:'pause'}));assert.equal(await updateReadiness(f.directory,{now}),true);
});
test('bootstrap moves only service executables into bundle; recovery retains data and restores running state',async t=>{
 const f=await fixture(t);await writeFile(join(f.runtime,'device-key'),'fixture-secret');const before=await readFile(join(f.runtime,'bridge-state.json'),'utf8');
 assert.deepEqual(await prepareUpdate(f.directory,{...f,bootstrap:true}),{prepared:true});assert.deepEqual([...f.loaded],['setup-ui']);
 for(const name of ['bridge','device','tunnel']){const p=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',f.plists[name]]));assert.equal(ownedService(p,f.directory,name,{home:f.home}),true);assert.equal(p.WorkingDirectory,f.directory);assert.ok(p.ProgramArguments[0].startsWith(f.app));const foreign={...p,Program:'/unrelated'};assert.equal(ownedService(foreign,f.directory,name,{home:f.home}),false);}
 assert.deepEqual(await finishUpdate(f.directory,f),{recovered:true,stopped:false});assert.equal(f.loaded.size,4);assert.equal(f.disabled.size,0);
 assert.equal(await readFile(join(f.runtime,'device-key'),'utf8'),'fixture-secret');assert.equal(await readFile(join(f.runtime,'bridge-state.json'),'utf8'),before);
});
test('paused state survives update; abort restores original service files',async t=>{
 const f=await fixture(t);await writeFile(join(f.runtime,'lifecycle.json'),JSON.stringify({stopped:true,reason:'pause'}));
 const original=await readFile(f.plists.bridge,'utf8');await prepareUpdate(f.directory,f);await finishUpdate(f.directory,{...f,rollback:true});
 assert.equal(await readFile(f.plists.bridge,'utf8'),original);assert.equal(f.loaded.size,1);assert.deepEqual(JSON.parse(await readFile(join(f.runtime,'lifecycle.json'),'utf8')),{stopped:true,reason:'pause'});
});
test('foreign service rejects update before stopping processes or creating journal',async t=>{
 const f=await fixture(t);await writeFile(f.plists.device,JSON.stringify({Label:'foreign'}));await assert.rejects(prepareUpdate(f.directory,{...f,bootstrap:true}),/CONFLICT/);assert.equal(f.disabled.size,0);await assert.rejects(readFile(join(f.runtime,'app-update.json')),/ENOENT/);
});

test('failed post-update health retains recovery journal for the next launch',async t=>{
 const f=await fixture(t);await prepareUpdate(f.directory,{...f,bootstrap:true});
 await assert.rejects(finishUpdate(f.directory,{...f,verify:async()=>false}),/UPDATE_RECOVERY_REQUIRED/);
 assert.equal(JSON.parse(await readFile(join(f.runtime,'app-update.json'),'utf8')).stopped,false);
 assert.equal((await finishUpdate(f.directory,f)).recovered,true);
});

test('prepared setup updates and recovers without creating services or changing keys and preferences',async t=>{
 for(const rollback of [false,true]){
  const f=await fixture(t,{initialSetup:true});
  const saved={'device-key':'fixture-secret','stt-provider.json':'{"provider":"soniox"}','lifecycle.json':'{"stopped":true,"reason":"quit"}'};
  for(const [name,value] of Object.entries(saved))await writeFile(join(f.runtime,name),value);
  assert.deepEqual(await prepareUpdate(f.directory,f),{prepared:true});
  assert.equal(JSON.parse(await readFile(join(f.runtime,'app-update.json'),'utf8')).initialSetup,true);
  assert.deepEqual(await finishUpdate(f.directory,{...f,rollback}),{recovered:true,stopped:true});
  for(const [name,value] of Object.entries(saved))assert.equal(await readFile(join(f.runtime,name),'utf8'),value);
  assert.equal(f.calls.some(([cmd,action])=>cmd==='/bin/launchctl'&&action!=='print'),false);
  await assert.rejects(readFile(join(f.runtime,'app-update.json')),/ENOENT/);
 }
});

test('never-started setup retains absent lifecycle state across a successful update',async t=>{
 const f=await fixture(t,{initialSetup:true});
 await prepareUpdate(f.directory,f);assert.deepEqual(await finishUpdate(f.directory,f),{recovered:true,stopped:false});
 await assert.rejects(readFile(join(f.runtime,'lifecycle.json')),/ENOENT/);
});

test('missing service files do not bypass a loaded job, prior activity, or unreadable launchd',async t=>{
 for(const scenario of ['loaded','activity','state','launchd','marker']){
  const f=await fixture(t,{initialSetup:true});
  if(scenario==='loaded')f.loaded.add('bridge');
  if(scenario==='activity')await writeFile(join(f.runtime,'update-activity.json'),'{}');
  if(scenario==='state')await writeFile(join(f.runtime,'bridge-state.json'),'{}');
  if(scenario==='marker')await writeFile(join(f.runtime,'install.json'),'{}');
  if(scenario==='launchd')f.execute=async()=>{throw Object.assign(new Error('denied'),{code:1});};
  await assert.rejects(prepareUpdate(f.directory,f));
  await assert.rejects(readFile(join(f.runtime,'app-update.json')),/ENOENT/);
  assert.equal(f.disabled.size,0);
 }
});

test('partial configured services fail without stopping the remaining jobs',async t=>{
 const f=await fixture(t);await rm(f.plists.tunnel);
 await assert.rejects(prepareUpdate(f.directory,{...f,bootstrap:true}),/SERVICE_SETUP_REQUIRED/);
 assert.equal(f.loaded.size,4);assert.equal(f.disabled.size,0);
});

test('initial setup changed before recovery retains its journal and never starts new services',async t=>{
 const f=await fixture(t,{initialSetup:true});await prepareUpdate(f.directory,f);
 f.loaded.add('bridge');
 await assert.rejects(finishUpdate(f.directory,f),/UPDATE_SETUP_CHANGED/);
 assert.equal(JSON.parse(await readFile(join(f.runtime,'app-update.json'),'utf8')).initialSetup,true);
 assert.equal(f.calls.some(([cmd,action])=>cmd==='/bin/launchctl'&&action!=='print'),false);
});

test('only explicit manual interruption stops a busy relay; recovery preserves queued work and pairing',async t=>{
 const f=await fixture(t),now=Date.now();
 await writeFile(join(f.runtime,'update-activity.json'),JSON.stringify({at:now,lastClient:now,active:3}));
 const messages=JSON.stringify({messages:[{id:'fixture-pending',status:'pending'},{id:'fixture-accepted',status:'accepted'}]});
 await writeFile(join(f.runtime,'bridge-state.json'),messages);
 await writeFile(join(f.runtime,'pairing.json'),'fixture-pairing');
 assert.deepEqual(await prepareUpdate(f.directory,f),{waiting:true});
 assert.equal(f.loaded.size,4);
 assert.deepEqual(await prepareUpdate(f.directory,{...f,interrupt:true}),{prepared:true});
 assert.deepEqual([...f.loaded],['setup-ui']);
 assert.equal(JSON.parse(await readFile(join(f.runtime,'app-update.json'),'utf8')).stopped,false);
 await finishUpdate(f.directory,f);
 assert.equal(f.loaded.size,4);assert.equal(f.disabled.size,0);
 assert.equal(await readFile(join(f.runtime,'bridge-state.json'),'utf8'),messages);
 assert.equal(await readFile(join(f.runtime,'pairing.json'),'utf8'),'fixture-pairing');
});

test('manual update keeps an already paused relay paused',async t=>{
 const f=await fixture(t);
 await writeFile(join(f.runtime,'lifecycle.json'),JSON.stringify({stopped:true,reason:'pause'}));
 f.loaded.clear();f.loaded.add('setup-ui');
 await prepareUpdate(f.directory,{...f,interrupt:true});
 assert.deepEqual(await finishUpdate(f.directory,f),{recovered:true,stopped:true});
 assert.deepEqual([...f.loaded],['setup-ui']);
 assert.equal(JSON.parse(await readFile(join(f.runtime,'lifecycle.json'),'utf8')).reason,'pause');
});

test('manual interruption still verifies the app before stopping services',async t=>{
 const f=await fixture(t),execute=f.execute;
 f.execute=async(cmd,args)=>{if(cmd==='/usr/bin/codesign')throw new Error('INVALID_SIGNATURE');return execute(cmd,args);};
 await assert.rejects(prepareUpdate(f.directory,{...f,interrupt:true}),/INVALID_SIGNATURE/);
 assert.equal(f.disabled.size,0);assert.equal(f.loaded.size,4);
 await assert.rejects(readFile(join(f.runtime,'app-update.json')),/ENOENT/);
});

test('failed manual preparation restores running services and original files',async t=>{
 const f=await fixture(t),execute=f.execute,original=await readFile(f.plists.bridge,'utf8');let failed=false;
 f.execute=async(cmd,args)=>{if(!failed&&cmd==='/bin/launchctl'&&args[0]==='bootout'){failed=true;throw new Error('STOP_FAILED');}return execute(cmd,args);};
 await assert.rejects(prepareUpdate(f.directory,{...f,interrupt:true}),/STOP_FAILED/);
 assert.equal(f.loaded.size,4);assert.equal(f.disabled.size,0);
 assert.equal(await readFile(f.plists.bridge,'utf8'),original);
 await assert.rejects(readFile(join(f.runtime,'app-update.json')),/ENOENT/);
});

test('failed rollback is actionable and retains the journal for recovery',async t=>{
 const f=await fixture(t),execute=f.execute;
 f.execute=async(cmd,args)=>{if(cmd==='/bin/launchctl'&&['bootout','enable'].includes(args[0]))throw new Error('SERVICE_FAILED');return execute(cmd,args);};
 await assert.rejects(prepareUpdate(f.directory,{...f,interrupt:true}),/UPDATE_RECOVERY_REQUIRED/);
 assert.equal(JSON.parse(await readFile(join(f.runtime,'app-update.json'),'utf8')).stopped,false);
 f.execute=execute;
 assert.deepEqual(await finishUpdate(f.directory,{...f,rollback:true}),{recovered:true,stopped:false});
});

test('GUI preparation arms post-exit recovery before handing installation to Sparkle',async t=>{
 const f=await fixture(t);let armed=false;
 await prepareUpdate(f.directory,{...f,interrupt:true,hostPID:123,armRecovery:async(directory,context)=>{
  assert.equal(directory,f.directory);assert.equal(context.hostPID,123);
  assert.equal(context.app,f.app);assert.deepEqual([...f.loaded],['setup-ui']);
  assert.equal(JSON.parse(await readFile(join(f.runtime,'app-update.json'),'utf8')).backup,context.backup);
  armed=true;
 }});
 assert.equal(armed,true);
});

test('watcher startup failure rolls preparation back instead of permitting an unprotected update',async t=>{
 const f=await fixture(t),original=await readFile(f.plists.device,'utf8');
 await assert.rejects(prepareUpdate(f.directory,{...f,interrupt:true,hostPID:123,armRecovery:async()=>{throw new Error('UPDATE_WATCH_NOT_READY');}}),/UPDATE_WATCH_NOT_READY/);
 assert.equal(f.loaded.size,4);assert.equal(f.disabled.size,0);
 assert.equal(await readFile(f.plists.device,'utf8'),original);
 await assert.rejects(readFile(join(f.runtime,'app-update.json')),/ENOENT/);
});

test('live-host rollback cancels exit recovery before ownership checks can fail',async t=>{
 const f=await fixture(t);await prepareUpdate(f.directory,{...f,interrupt:true});
 await writeFile(f.plists.device,JSON.stringify({Label:'foreign'}));
 await assert.rejects(finishUpdate(f.directory,{...f,rollback:true}),/CONFLICT/);
 const journal=JSON.parse(await readFile(join(f.runtime,'app-update.json'),'utf8'));
 assert.equal(journal.exitRecoveryCancelled,true);assert.equal(journal.stopped,false);
});

test('repeated real preparation and finish, including aborted updates, retain only the latest backup',async t=>{
 const f=await fixture(t),root=join(f.runtime,'update-backups');
 for(let n=0;n<30;n++){
  await prepareUpdate(f.directory,{...f,interrupt:true});
  const journal=JSON.parse(await readFile(join(f.runtime,'app-update.json'),'utf8'));
  assert.ok((await readdir(root)).length<=2);
  await finishUpdate(f.directory,{...f,rollback:n%3===0});
  assert.deepEqual(await readdir(root),[journal.backup.split('/').at(-2)]);
  assert.equal(f.loaded.size,4);
 }
});

test('failed health preserves all recovery copies, then successful recovery prunes and startup retries',async t=>{
 const f=await fixture(t),root=join(f.runtime,'update-backups');
 await prepareUpdate(f.directory,{...f,interrupt:true});await finishUpdate(f.directory,f);
 await prepareUpdate(f.directory,{...f,interrupt:true});
 await assert.rejects(finishUpdate(f.directory,{...f,verify:async()=>false}),/UPDATE_RECOVERY_REQUIRED/);
 assert.equal((await readdir(root)).length,2);
 await finishUpdate(f.directory,f);assert.equal((await readdir(root)).length,1);
 // An interrupted cleanup/legacy generation is removed even with no journal.
 const orphan=join(root,'1700000000000');await mkdir(orphan);
 await finishUpdate(f.directory,{...f,verify:async()=>false});assert.equal((await readdir(root)).length,2);
 assert.deepEqual(await finishUpdate(f.directory,f),{recovered:false});assert.equal((await readdir(root)).length,1);
});

test('GUI startup returns without cleanup health/signature work and schedules a separate sweep',async t=>{
 const f=await fixture(t);let launched=0,checked=0;
 await finishUpdate(f.directory,{...f,backgroundCleanup:true,verify:async()=>{checked++;return true;},launchCleanup:directory=>{assert.equal(directory,f.directory);launched++;}});
 assert.equal(checked,0);assert.equal(launched,1);
 assert.equal(f.calls.some(([cmd])=>cmd==='/usr/bin/codesign'),false);
});

test('background cleanup cannot recover an update that started before it acquired the lock',async t=>{
 const f=await fixture(t);await prepareUpdate(f.directory,{...f,interrupt:true});
 const path=join(f.runtime,'app-update.json'),before=await readFile(path,'utf8');
 assert.deepEqual(await finishUpdate(f.directory,{...f,cleanupOnly:true}),{recovered:false});
 assert.equal(await readFile(path,'utf8'),before);assert.equal(f.loaded.has('bridge'),false);
 await finishUpdate(f.directory,f);
});

test('a normal GUI launch does not wait for an older background sweep lock',async t=>{
 const f=await fixture(t);let launched=0;
 await withUpdateStorage(f.directory,async()=>{
  assert.deepEqual(await finishUpdate(f.directory,{...f,backgroundCleanup:true,launchCleanup:()=>{launched++;}}),{recovered:false});
 });
 assert.equal(launched,1);
});
