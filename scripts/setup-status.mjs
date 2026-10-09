// Read the selected installation without changing its source or importing its helpers.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tailscale } from './lib/setup.mjs';
process.chdir(resolve(process.argv[2]));
let key;try{key=(await readFile('.runtime/device-key','utf8')).trim();}catch{}
let bridge=false,device=false,tunnel=false,subscribed=false;
if(key){
 try{const r=await fetch('http://127.0.0.1:3460/api/status',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(2000)});if(r.ok){const s=await r.json();bridge=true;subscribed=s.subscribed===true;}}catch{}
 try{const ts=await tailscale();if(ts.state==='ready')device=(await fetch(ts.origin+'/api/status',{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(3000)})).ok;}catch{}
}
try{tunnel=(await fetch('http://127.0.0.1:3461/readyz',{signal:AbortSignal.timeout(2000)})).ok;}catch{}
console.log(JSON.stringify({bridge,device,tunnel,subscribed}));
