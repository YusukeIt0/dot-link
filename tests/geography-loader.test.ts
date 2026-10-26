import test from 'node:test';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalGeography, type GeographyUpdate } from '../server/geography/loader.ts';
import { GeographicCache } from '../server/geography/cache.ts';
import { geographicRegion } from '../server/geography/overture.ts';

test('worker resolves reusable region data against each latest fix without persisting phone measurements',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dot-map-worker-'));
 let loader:LocalGeography|undefined;
 try {
  const fix={longitude:.005,latitude:.005,accuracy:5};const region=geographicRegion(fix)!;
  const dataset={source:'Overture Maps',release:'2026-10-21.0',attribution:'Synthetic fixture',license_url:'https://docs.overturemaps.org/attribution/',limitations:[],features:[{id:'land:fixture',kind:'peak',name:'Synthetic Peak',category:'landmark',geometry:{type:'Point',coordinates:[.006,.005]}}]};
  await new GeographicCache(directory).put(`normalized-${region.key}`,Buffer.from(JSON.stringify(dataset)));
  const updates:GeographyUpdate[]=[];
  let notify:(r:GeographyUpdate)=>void=()=>{};
  loader=new LocalGeography(directory,r=>{updates.push(r);notify(r)});
  const ready=()=>new Promise<GeographyUpdate>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Worker did not return cached region')),5000);notify=r=>{if(r.state==='ready'){clearTimeout(timeout);resolve(r);}};});
  let pending=ready();loader.update(fix);const first=await pending;
  assert.ok(first.evidence!.landmarks[0].distance_m>100);
  pending=ready();loader.update({...fix,longitude:.006});const second=await pending;
  assert.equal(second.evidence!.landmarks[0].distance_m,0);assert.equal(second.revision,first.revision);
  loader.stop();const count=updates.length;
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(updates.length,count);
  assert.equal((await readdir(directory)).length,1);
 } finally {loader?.close();await rm(directory,{recursive:true,force:true});}
});

test('repeated worker crashes back off across fresh workers and stop resets the crash cadence',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dot-map-crash-'));let loader:LocalGeography|undefined;
 let time=0,created=0,failed=0;const updates:GeographyUpdate[]=[];
 const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check());};
 try {
  loader=new LocalGeography(directory,r=>{updates.push(r);if(r.state==='unavailable'&&r.revision.startsWith('failed-'))failed++;},{now:()=>time,createWorker:()=>{created++;return new Worker('process.exit(1)',{eval:true});}});
  const fix={longitude:0,latitude:0,accuracy:5};
  loader.update(fix);await until(()=>failed===1);
  time=59_999;loader.update(fix);assert.equal(created,1);assert.equal(updates.at(-1)?.state,'unavailable');assert.deepEqual(updates.at(-1)?.fix,fix);assert.match(updates.at(-1)!.revision,/^backoff-/);
  time=60_000;loader.update(fix);await until(()=>failed===2);
  time=120_000;loader.update(fix);assert.equal(created,2);
  time=180_000;loader.update(fix);await until(()=>failed===3);
  time=300_000;loader.update(fix);assert.equal(created,3);
  loader.stop();loader.update(fix);await until(()=>failed===4);
  time+=60_000;loader.update(fix);await until(()=>failed===5);
 }finally{loader?.close();await rm(directory,{recursive:true,force:true});}
});

test('a ready result resets previous worker-crash backoff',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dot-map-crash-ready-'));let loader:LocalGeography|undefined;
 let time=0,created=0,failed=0,ready=0;
 const fix={longitude:0,latitude:0,accuracy:5};
 const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check());};
 try {
  loader=new LocalGeography(directory,r=>{if(r.state==='unavailable'&&r.revision.startsWith('failed-'))failed++;if(r.state==='ready')ready++;},{now:()=>time,createWorker:()=>{
   created++;
   return new Worker(created===3?`const {parentPort}=require('node:worker_threads');parentPort.once('message',()=>{parentPort.postMessage({fix:${JSON.stringify(fix)},state:'ready',revision:'fixture'});setTimeout(()=>process.exit(1),5);});`:'process.exit(1)',{eval:true});
  }});
  loader.update(fix);await until(()=>failed===1);
  time=60_000;loader.update(fix);await until(()=>failed===2);
  time=180_000;loader.update(fix);await until(()=>failed===3);assert.equal(ready,1);
  time=240_000;loader.update(fix);await until(()=>failed===4);assert.equal(created,4);
 }finally{loader?.close();await rm(directory,{recursive:true,force:true});}
});
