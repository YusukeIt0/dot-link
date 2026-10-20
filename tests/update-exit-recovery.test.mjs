import test from 'node:test';
import assert from 'node:assert/strict';
import {watchUpdateExit} from '../scripts/lib/update-exit-recovery.mjs';

function fixture(){
 const args={directory:'/fixture/runtime',app:'/fixture/Dot Link.app',backup:'/fixture/backup',hostPID:42};
 const state={time:0,host:true,installer:true,journal:true,app:false,opened:0,ready:0};
 const options={
  now:()=>state.time,timeout:15000,
  wait:async ms=>{state.time+=ms;},
  identity:async()=>state.host?'Mon Oct 19 10:00:00 2026 /fixture/Dot Link.app/Contents/MacOS/DotLink':'',
  installing:async()=>state.installer,
  readJournal:async()=>{if(!state.journal)throw Object.assign(new Error('missing'),{code:'ENOENT'});return {backup:args.backup};},
  appRunning:async()=>state.app,
  reopen:async()=>{assert.equal(state.host,false);assert.equal(state.installer,false);state.opened++;},
  ready:()=>{state.ready++;}
 };
 return {args,state,options};
}
test('post-exit failure waits for installer ownership to end, then reopens once',async()=>{
 const {args,state,options}=fixture();
 options.wait=async ms=>{state.time+=ms;if(state.time>=1000)state.host=false;if(state.time>=5000)state.installer=false;};
 assert.equal(await watchUpdateExit(args,options),'reopened');
 assert.equal(state.ready,1);assert.equal(state.opened,1);assert.ok(state.time>=8000);
});
test('successful relaunch consumes journal without a second launch',async()=>{
 const {args,state,options}=fixture();
 options.wait=async ms=>{state.time+=ms;state.host=false;state.installer=false;state.journal=false;};
 assert.equal(await watchUpdateExit(args,options),'recovered');assert.equal(state.opened,0);
});
test('live app remains responsible for callback recovery and a stalled installer is never raced',async()=>{
 for(const host of [true,false]){
  const {args,state,options}=fixture();
  options.wait=async ms=>{state.time+=ms;state.host=host;};
  assert.equal(await watchUpdateExit(args,options),'expired');assert.equal(state.opened,0);
 }
});
test('slow app startup is left to finish its own journal recovery',async()=>{
 const {args,state,options}=fixture();
 options.wait=async ms=>{state.time+=ms;state.host=false;state.installer=false;state.app=true;};
 assert.equal(await watchUpdateExit(args,options),'app-running');assert.equal(state.opened,0);
});
test('changed journal cancels the old watcher',async()=>{
 const {args,state,options}=fixture();
 options.wait=async ms=>{state.time+=ms;args.backup='/fixture/new-backup';};
 // The watcher's expected identity is captured at invocation, not this object.
 assert.equal(await watchUpdateExit({...args},options),'recovered');assert.equal(state.opened,0);
});
test('uncertain process state fails closed before readiness and during observation',async()=>{
 for(const when of ['before','after']){
  const {args,state,options}=fixture();
  options.installing=async()=>{if(when==='before'||state.time>0)throw new Error('DENIED');return true;};
  options.wait=async ms=>{state.time+=ms;state.host=false;};
  await assert.rejects(watchUpdateExit(args,options),/DENIED/);
  assert.equal(state.ready,when==='before'?0:1);assert.equal(state.opened,0);
 }
});
test('unrelated host or absent installer cannot arm a recovery watcher',async()=>{
 for(const scenario of ['host','installer']){
  const {args,state,options}=fixture();
  if(scenario==='host')options.identity=async()=>'/other/app';
  else state.installer=false;
  await assert.rejects(watchUpdateExit(args,options),/UPDATE_WATCH_NOT_READY/);
  assert.equal(state.ready,0);assert.equal(state.opened,0);
 }
});
test('installer reappearing during the relaunch grace period blocks fallback',async()=>{
 const {args,state,options}=fixture();let first=true;
 options.wait=async ms=>{
  state.time+=ms;state.host=false;
  if(first){state.installer=false;first=false;}
  else state.installer=true;
 };
 assert.equal(await watchUpdateExit(args,options),'expired');assert.equal(state.opened,0);
});
