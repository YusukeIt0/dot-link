import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath, symlink, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lifecycleState, suspendServices, resumeServices, waitForRelay } from '../scripts/lib/app-lifecycle.mjs';
import { uninstallPlan, uninstallApp } from '../scripts/lib/app-uninstall.mjs';
const exists=p=>access(p).then(()=>true,()=>false);
async function fixture(t,{managed=false}={}) {
 const home=await realpath(await mkdtemp(join(tmpdir(),'dot-lifecycle-')));t.after(()=>rm(home,{recursive:true,force:true}));
 const directory=managed?join(home,'Library/Application Support/Dot Link'):join(home,'even-g2-dot');
 const app=join(home,'Applications/Dot Link.app'), runtime=join(directory,'.runtime');
 for(const p of [runtime,join(runtime,'bin'),join(runtime,'models'),join(app,'Contents/MacOS'),join(home,'Library/LaunchAgents')])await mkdir(p,{recursive:true});
 await writeFile(join(directory,'package.json'),JSON.stringify({name:'even-g2-dot'}));
 await writeFile(join(runtime,'install.json'),JSON.stringify({product:'Dot Link',format:1}));
 await writeFile(join(runtime,'bridge-state.json'),'private fixture history');
 await writeFile(join(runtime,'device-key'),'test-only-key');
 await writeFile(join(runtime,'models/model.bin'),'fixture model');
 await writeFile(join(runtime,'bin/node'),'fixture binary');
 await writeFile(join(directory,'keep-source.txt'),'source');
 await writeFile(join(app,'Contents/Info.plist'),'fixture');
 await writeFile(join(app,'Contents/MacOS/DotLink'),'fixture');
 const labels=['bridge','device','tunnel','setup-ui'];
 const plists={};
 for(const name of labels){
  const label='local.even-g2-dot.'+name;
  const p={Label:label,WorkingDirectory:name==='setup-ui'?join(app,'Contents'):directory,ProgramArguments:name==='setup-ui'?[join(app,'Contents/MacOS/DotLink'),'--background']:name==='tunnel'?['tunnel','--profile-file',join(runtime,'tunnel.yaml')]:['node',join(directory,'server',name==='bridge'?'main.ts':'device-main.ts')]};
  const file=join(home,'Library/LaunchAgents',label+'.plist');await writeFile(file,JSON.stringify(p));plists[name]=file;
 }
 const loaded=new Set(labels.map(n=>'gui/501/local.even-g2-dot.'+n));const disabled=new Set(),calls=[];
 const execute=async(file,args)=>{
  calls.push([file,...args]);
  if(file==='/usr/bin/plutil')return args[0]==='-extract'?'app.tripsurf.dotlink.mac':readFile(args.at(-1),'utf8');
  if(file==='/bin/launchctl'){
   const [op,target,path]=args;
   if(op==='disable')disabled.add(target);
   else if(op==='enable')disabled.delete(target);
   else if(op==='print'){if(!loaded.has(target))throw new Error('not loaded');return 'state = running';}
   else if(op==='bootout')loaded.delete(target);
   else if(op==='bootstrap'){const p=JSON.parse(await readFile(path,'utf8'));loaded.add(target+'/'+p.Label);}
   else throw new Error('unexpected op');
   return '';
  }
  throw new Error('unexpected command');
 };
 return {home,directory,app,runtime,plists,loaded,disabled,calls,execute,uid:501,wait:async()=>{}};
}
test('pause stops all relay jobs and persists across login without stopping the UI; resume restores services',async t=>{
 const f=await fixture(t);await suspendServices(f.directory,f);
 assert.deepEqual([...f.loaded],['gui/501/local.even-g2-dot.setup-ui']);
 assert.equal(f.disabled.size,3);assert.deepEqual(await lifecycleState(f.directory),{lifecycleStopped:true,lifecycleReason:'pause'});
 await resumeServices(f.directory,f);assert.equal(f.loaded.size,4);assert.equal(f.disabled.size,0);assert.equal((await lifecycleState(f.directory)).lifecycleStopped,false);
});
test('quit disables GUI autostart too; does not bootout the helper parent before completion',async t=>{
 const f=await fixture(t);await suspendServices(f.directory,{...f,reason:'quit'});
 assert.equal(f.disabled.size,4);assert.equal(f.loaded.size,1);assert.equal((await lifecycleState(f.directory)).lifecycleReason,'quit');
 await resumeServices(f.directory,f);assert.equal(f.disabled.size,0);
});
test('foreign service blocks all stop and uninstall changes before any command mutates state',async t=>{
 const f=await fixture(t);await writeFile(f.plists.tunnel,JSON.stringify({Label:'local.even-g2-dot.tunnel',WorkingDirectory:'/foreign',ProgramArguments:['other']}));
 await assert.rejects(suspendServices(f.directory,{...f,reason:'quit'}),/CONFLICT/);
 await assert.rejects(uninstallPlan(f.directory,f.app,f),/CONFLICT/);
 assert.equal(f.disabled.size,0);assert.equal(await exists(join(f.runtime,'lifecycle.json')),false);
});
test('changed confirmation token and symlink roots refuse uninstall without stopping anything',async t=>{
 const f=await fixture(t);const p=await uninstallPlan(f.directory,f.app,f);
 await writeFile(f.plists.bridge,(await readFile(f.plists.bridge,'utf8'))+'\n');
 await assert.rejects(uninstallApp(f.directory,f.app,{...f,token:p.token}),/PLAN_CHANGED/);assert.equal(f.disabled.size,0);
 const other=join(f.home,'alias.app');await symlink(f.app,other);
 await assert.rejects(uninstallPlan(f.directory,other,f),/UNSAFE_INSTALL_PATH/);
});
test('legacy uninstall removes known data and models while preserving source and unrelated development state',async t=>{
 const f=await fixture(t);await writeFile(join(f.runtime,'deploy-key'),'do not touch');
 await writeFile(join(f.runtime,'mcp-authorization-header'),'fixture header');
 const p=await uninstallPlan(f.directory,f.app,f);
 assert.ok(p.removes.includes(join(f.runtime,'bridge-state.json')));
 const r=await uninstallApp(f.directory,f.app,{...f,token:p.token});
 assert.equal(r.uninstalled,true);assert.equal(r.deleteData,true);assert.equal(r.savedData,undefined);
 for(const path of [f.app,join(f.runtime,'models'),join(f.runtime,'bridge-state.json'),join(f.runtime,'device-key'),join(f.runtime,'mcp-authorization-header'),f.plists.bridge,f.plists['setup-ui']])assert.equal(await exists(path),false,path);
 assert.equal(await readFile(join(f.directory,'keep-source.txt'),'utf8'),'source');assert.equal(await readFile(join(f.runtime,'deploy-key'),'utf8'),'do not touch');
 const history=(await readdir(r.trash)).find(n=>n.endsWith('-bridge-state.json'));
 assert.equal(await readFile(join(r.trash,history),'utf8'),'private fixture history');
});
test('managed uninstall defaults to removing all data with recoverable contents in Trash',async t=>{
 const f=await fixture(t,{managed:true});const p=await uninstallPlan(f.directory,f.app,f);const r=await uninstallApp(f.directory,f.app,{...f,token:p.token});
 assert.equal(await exists(f.directory),false);assert.equal(await exists(f.app),false);assert.equal(r.savedData,undefined);
 assert.equal(await exists(join(f.home,'Library/Application Support/Dot Link Saved Data')),false);
 const payload=(await readdir(r.trash)).find(n=>n.endsWith('-Dot Link'));
 for(const [path,contents] of [['bridge-state.json','private fixture history'],['device-key','test-only-key'],['models/model.bin','fixture model']])assert.equal(await readFile(join(r.trash,payload,'.runtime',path),'utf8'),contents);
});
test('obsolete retain-data requests fail before stopping services or moving files',async t=>{
 const f=await fixture(t,{managed:true});const p=await uninstallPlan(f.directory,f.app,f);
 for(const deleteData of [false,'true',null])await assert.rejects(uninstallApp(f.directory,f.app,{...f,token:p.token,deleteData}),/INVALID_UNINSTALL_OPTION/);
 assert.equal(f.disabled.size,0);assert.equal(await exists(f.app),true);assert.equal(await exists(join(f.runtime,'bridge-state.json')),true);assert.equal(await exists(join(f.home,'.Trash')),false);
});
test('stop failure prevents file removal and reports failure rather than successful uninstall',async t=>{
 const f=await fixture(t);const p=await uninstallPlan(f.directory,f.app,f);
 const execute=async(file,args)=>{if(file==='/bin/launchctl'&&args[0]==='bootout')throw new Error('denied');return f.execute(file,args);};
 await assert.rejects(uninstallApp(f.directory,f.app,{...f,execute,token:p.token}),/UNINSTALL_FAILED_RESTORED/);
 assert.equal(await exists(f.app),true);assert.equal(await exists(join(f.runtime,'bridge-state.json')),true);assert.equal(await exists(f.plists.bridge),true);
});

test('a late filesystem failure restores earlier moved runtime and login items',async t=>{
 const f=await fixture(t);const p=await uninstallPlan(f.directory,f.app,f);
 const apps=join(f.home,'Applications');await chmod(apps,0o500);
 try {
  await assert.rejects(uninstallApp(f.directory,f.app,{...f,token:p.token}),/UNINSTALL_FAILED_RESTORED/);
  assert.equal(await exists(f.app),true);assert.equal(await exists(join(f.runtime,'models/model.bin')),true);
  assert.equal(await exists(f.plists.bridge),true);assert.equal(await exists(f.plists['setup-ui']),true);
  assert.equal(await readFile(join(f.runtime,'bridge-state.json'),'utf8'),'private fixture history');
 } finally { await chmod(apps,0o700); }
});

test('shutdown waits for a draining process after its launchd registration disappears',async t=>{
 const f=await fixture(t);let polls=0;
 const execute=async(file,args)=>{
  if(file==='/bin/ps'){polls++;return polls<3?'S':'';}
  const result=await f.execute(file,args);
  return file==='/bin/launchctl'&&args[0]==='print'?'state = running\n pid = 12345\n':result;
 };
 await suspendServices(f.directory,{...f,execute});assert.ok(polls>=3);
});
test('shutdown does not report success if a process refuses to finish',async t=>{
 const f=await fixture(t);
 const execute=async(file,args)=>{
  if(file==='/bin/ps')return 'S';
  const result=await f.execute(file,args);
  return file==='/bin/launchctl'&&args[0]==='print'?'state = running\n pid = 12345\n':result;
 };
 await assert.rejects(suspendServices(f.directory,{...f,execute}),/SERVICE_STILL_STOPPING/);
});
test('resume also restores an owned legacy notification job while migration is pending',async t=>{
 const f=await fixture(t), label='local.even-g2-dot.menu';
 const file=join(f.home,'Library/LaunchAgents',label+'.plist');
 await writeFile(file,JSON.stringify({Label:label,WorkingDirectory:f.directory,ProgramArguments:[join(f.directory,'.runtime/notification-menu/Dot Notification Lab.app/Contents/MacOS/DotNotificationLab')]}));
 f.loaded.add('gui/501/'+label);
 await suspendServices(f.directory,f);assert.equal(f.loaded.has('gui/501/'+label),false);
 await resumeServices(f.directory,f);assert.equal(f.loaded.has('gui/501/'+label),true);
});

test('resume readiness waits for actual service health and preserves a bounded failure state',async()=>{
 let polls=0;const state=await waitForRelay(async()=>++polls<3?{bridge:false,device:false,tunnel:false}:{bridge:true,device:true,tunnel:true,subscribed:true},{wait:async()=>{}});
 assert.equal(polls,3);assert.equal(state.subscribed,true);
 polls=0;const failed=await waitForRelay(async()=>{polls++;return {bridge:true,device:false,tunnel:false};},{attempts:2,wait:async()=>{}});
 assert.equal(polls,2);assert.equal(failed.device,false);
});
