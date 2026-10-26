import test from 'node:test';
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
