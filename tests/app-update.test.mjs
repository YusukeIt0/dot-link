import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from '../scripts/lib/setup.mjs';
import {ownedService} from '../scripts/lib/service-management.mjs';
import {prepareUpdate,finishUpdate,updateReadiness} from '../scripts/lib/app-update.mjs';
async function fixture(t){
 const home=await realpath(await mkdtemp(join(tmpdir(),'dot-update-')));t.after(()=>rm(home,{recursive:true,force:true}));
 const directory=join(home,'even-g2-dot'),runtime=join(directory,'.runtime'),app=join(home,'Applications/Dot Link.app'),agents=join(home,'Library/LaunchAgents');
 for(const p of [runtime,join(app,'Contents'),agents])await mkdir(p,{recursive:true});
 await writeFile(join(app,'Contents/Info.plist'),'fixture');
 await writeFile(join(runtime,'bridge-state.json'),JSON.stringify({messages:[]}));
 const plists={};for(const name of ['bridge','device','tunnel','setup-ui']){
  const label='local.even-g2-dot.'+name,p={Label:label,WorkingDirectory:name==='setup-ui'?join(app,'Contents'):directory,ProgramArguments:name==='setup-ui'?[join(app,'Contents/MacOS/DotLink')]:name==='tunnel'?['tunnel','run','--profile-file',join(runtime,'tunnel.yaml')]:['node',join(directory,'server',name==='bridge'?'main.ts':'device-main.ts')],EnvironmentVariables:{G2_DEVICE_ORIGIN:'https://example.ts.net'}};
  plists[name]=join(agents,label+'.plist');await writeFile(plists[name],JSON.stringify(p));
 }
 const loaded=new Set(Object.keys(plists)),disabled=new Set(),calls=[];
 const execute=async(cmd,args)=>{
  calls.push([cmd,...args]);
  if(cmd==='/usr/bin/codesign')return '';
  if(cmd==='/usr/bin/plutil'){if(args[0]==='-extract')return args[1]==='CFBundleVersion'?'1':'app.tripsurf.dotlink.mac';return run(cmd,args);}
  if(cmd==='/bin/launchctl'){const name=args[1].split('.').at(-1);if(args[0]==='print'){if(!loaded.has(name))throw new Error('not loaded');return 'state = running';}if(args[0]==='disable')disabled.add(name);if(args[0]==='enable')disabled.delete(name);if(args[0]==='bootout')loaded.delete(name);if(args[0]==='bootstrap'){const p=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',args[2]]));loaded.add(p.Label.split('.').at(-1));}return '';}
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
