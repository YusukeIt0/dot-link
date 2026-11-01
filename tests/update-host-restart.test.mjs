import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {restartUpdateHost} from '../scripts/lib/update-host-restart.mjs';

async function fixture(t){
 const home=await realpath(await mkdtemp(join(tmpdir(),'dot-host-')));t.after(()=>rm(home,{recursive:true,force:true}));
 const app=join(home,'Applications/Dot Link.app');await mkdir(join(app,'Contents'),{recursive:true});await writeFile(join(app,'Contents/Info.plist'),'fixture');
 const args={app,hostPID:42,token:'12345678-1234-1234-1234-123456789abc'};
 const original=`501 Mon Nov 1 12:00:00 2026 ${app}/Contents/MacOS/DotLink`;
 const state={identity:original,signals:[],opens:[],ready:0,waits:0,verified:0};
 const options={home,uid:501,
  execute:async(cmd,a)=>{
   if(cmd==='/bin/ps')return state.identity;
   if(cmd==='/usr/bin/plutil')return 'app.tripsurf.dotlink.mac';
   if(cmd==='/usr/bin/codesign'){state.verified++;return '';}
   if(cmd==='/usr/bin/open'){assert.notEqual(state.identity,original);state.opens.push(a);return '';}
   throw Error('unexpected command');
  },
  ready:()=>state.ready++,wait:async()=>{state.waits++;state.identity='';},
  signal:(pid,s)=>{assert.equal(pid,42);state.signals.push(s);}
 };
 return {args,options,state,original};
}
test('fresh host handoff verifies app and actual old exit before one background relaunch',async t=>{
 const {args,options,state}=await fixture(t);
 assert.equal(await restartUpdateHost(args,options),'reopened');
 assert.equal(state.ready,1);assert.equal(state.verified,2);assert.equal(state.waits,1);assert.deepEqual(state.signals,[]);
 assert.deepEqual(state.opens,[['-g',args.app,'--args','--background','--resume-update',args.token]]);
});
test('unresponsive original host receives bounded TERM/KILL and still must exit',async t=>{
 const {args,options,state}=await fixture(t);
 options.wait=async()=>{state.waits++;if(state.signals.includes('SIGKILL'))state.identity='';};
 assert.equal(await restartUpdateHost(args,options),'reopened');
 assert.deepEqual(state.signals,['SIGTERM','SIGKILL']);assert.equal(state.opens.length,1);
});
test('a host that remains alive is never reported restarted or launched over',async t=>{
 const {args,options,state}=await fixture(t);options.wait=async()=>{};
 await assert.rejects(restartUpdateHost(args,options),/STILL_RUNNING/);assert.equal(state.opens.length,0);
});
test('PID reuse is not signalled',async t=>{
 const {args,options,state}=await fixture(t);options.wait=async()=>{state.identity='501 Tue Nov 2 12:00:00 2026 /other/app';};
 await restartUpdateHost(args,options);assert.deepEqual(state.signals,[]);assert.equal(state.opens.length,1);
});
test('unrelated process, different owner, invalid PID or token cannot arm',async t=>{
 for(const kind of ['process','owner','pid','token']){
  const {args,options,state}=await fixture(t);
  if(kind==='process')state.identity='501 Mon Nov 1 12:00:00 2026 /other/DotLink';
  if(kind==='owner')state.identity=state.identity.replace(/^501/,'502');
  if(kind==='pid')args.hostPID=1;
  if(kind==='token')args.token='invalid';
  await assert.rejects(restartUpdateHost(args,options),/INVALID/);
  assert.equal(state.ready,0);assert.deepEqual(state.signals,[]);assert.deepEqual(state.opens,[]);
 }
});
test('signature failure before arming or after exit never opens an unverified app',async t=>{
 for(const failAt of [1,2]){
  const {args,options,state}=await fixture(t);const execute=options.execute;
  options.execute=async(cmd,a)=>{const result=await execute(cmd,a);if(cmd==='/usr/bin/codesign'&&state.verified===failAt)throw Error('invalid signature');return result;};
  await assert.rejects(restartUpdateHost(args,options),/invalid signature/);assert.equal(state.opens.length,0);
  assert.equal(state.ready,failAt-1);
 }
});
test('unknown process query failure is not treated as exit',async t=>{
 const {args,options,state}=await fixture(t);const execute=options.execute;
 options.execute=async(cmd,a)=>{if(cmd==='/bin/ps')throw Error('query failed');return execute(cmd,a);};
 await assert.rejects(restartUpdateHost(args,options),/query failed/);assert.equal(state.ready,0);assert.equal(state.opens.length,0);
});
test('LaunchServices failure is surfaced and never retried in a loop',async t=>{
 const {args,options,state}=await fixture(t);const execute=options.execute;
 options.execute=async(cmd,a)=>{await execute(cmd,a);if(cmd==='/usr/bin/open')throw Error('open failed');return cmd==='/usr/bin/plutil'?'app.tripsurf.dotlink.mac':cmd==='/bin/ps'?state.identity:'';};
 await assert.rejects(restartUpdateHost(args,options),/open failed/);assert.equal(state.opens.length,1);
});
test('exit racing a fallback signal is verified on the next observation',async t=>{
 const {args,options,state}=await fixture(t);options.wait=async()=>{};
 options.signal=()=>{state.identity='';throw Object.assign(new Error('already exited'),{code:'ESRCH'});};
 assert.equal(await restartUpdateHost(args,options),'reopened');assert.equal(state.opens.length,1);
});
test('a launchd-restarted UI is not opened a second time',async t=>{
 const {args,options,state}=await fixture(t);const execute=options.execute;
 options.execute=async(cmd,a)=>cmd==='/bin/ps'&&a[0]==='-axo'?`501 99 ${args.app}/Contents/MacOS/DotLink`:execute(cmd,a);
 assert.equal(await restartUpdateHost(args,options),'already-running');assert.equal(state.opens.length,0);
});
