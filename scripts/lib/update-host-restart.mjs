import {fork} from 'node:child_process';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {run} from './setup.mjs';
import {regularPath} from './app-lifecycle.mjs';
import {verifyUpdateApp} from './update-storage.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function restartUpdateHost({app,hostPID,token},{execute=run,wait=sleep,ready=()=>{},signal=(pid,s)=>process.kill(pid,s),home=homedir(),uid=process.getuid()}={}){
 if(app!==join(home,'Applications/Dot Link.app')||!Number.isSafeInteger(hostPID)||hostPID<2||!/^[-a-f0-9]{36}$/i.test(token))throw new Error('UPDATE_HOST_INVALID');
 await regularPath(app);await verifyUpdateApp(app,execute);
 const executable=join(app,'Contents/MacOS/DotLink');
 const identity=async()=>{
  try{return (await execute('/bin/ps',['-p',String(hostPID),'-o','uid=,lstart=,comm='])).trim();}
  catch(error){if(error.code===1)return '';throw error;}
 };
 const original=await identity();
 if(!original.startsWith(String(uid)+' ')||!original.endsWith(' '+executable))throw new Error('UPDATE_HOST_INVALID');
 ready();
 // The GUI first exits normally without stopping the relay. Only the exact
 // original host can receive a fallback signal, never a launchd job or name match.
 for(let attempt=0;attempt<80;attempt++){
  const current=await identity();
  if(current!==original){
   // A reused PID is not the old host. Revalidate disk before LaunchServices.
   await regularPath(app);await verifyUpdateApp(app,execute);
   await execute('/usr/bin/open',['-g',app,'--args','--background','--resume-update',token]);
   return 'reopened';
  }
  if(attempt===40)signal(hostPID,'SIGTERM');
  if(attempt===60)signal(hostPID,'SIGKILL');
  await wait(250);
 }
 throw new Error('UPDATE_HOST_STILL_RUNNING');
}
export async function armHostRestart(options){
 const child=fork(fileURLToPath(import.meta.url),['--watch',JSON.stringify(options)],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
 await new Promise((resolve,reject)=>{
  let settled=false;
  const finish=error=>{
   if(settled)return;settled=true;clearTimeout(timer);
   child.removeAllListeners('error');child.removeAllListeners('exit');child.removeAllListeners('message');
   if(error){child.kill();reject(error);}else{child.disconnect();child.unref();resolve();}
  };
  const timer=setTimeout(()=>finish(new Error('UPDATE_HOST_NOT_READY')),15000);
  child.once('error',finish);child.once('exit',()=>finish(new Error('UPDATE_HOST_NOT_READY')));
  child.once('message',message=>finish(message==='ready'?undefined:new Error('UPDATE_HOST_NOT_READY')));
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{
  const options=JSON.parse(process.argv[3]);
  if(process.argv[2]==='--watch')await restartUpdateHost(options,{ready:()=>process.send?.('ready')});
  else if(process.argv[2]==='--arm'){await armHostRestart(options);process.stdout.write('{"ready":true}\n');}
  else throw new Error('UPDATE_HOST_INVALID');
 }catch{process.exitCode=1;}
}
