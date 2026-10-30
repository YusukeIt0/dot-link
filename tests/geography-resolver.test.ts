import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GeographicCache } from '../server/geography/cache.ts';
import { GeographicResolver } from '../server/geography/resolver.ts';
import { geographicRegion, type acquireGeography } from '../server/geography/overture.ts';
import type { GeographicDataset, GeographicFix } from '../server/geography/types.ts';
import type { GeographyUpdate } from '../server/geography/loader.ts';

const first={longitude:.005,latitude:.005,accuracy:5};
const distant={longitude:1.005,latitude:1.005,accuracy:5};
const dataset=(fix=first,name='Reference peak'):GeographicDataset=>({source:'Overture Maps',release:'2026-10-21.0',attribution:'Synthetic model case',license_url:'https://docs.overturemaps.org/attribution/',limitations:[],features:[{id:'land:fixture',kind:'peak',name,category:'landmark',geometry:{type:'Point',coordinates:[fix.longitude,fix.latitude]}}]});
async function until(predicate:()=>boolean) {const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw new Error('Model case did not settle');await new Promise(resolve=>setTimeout(resolve,2));}}
async function setup() {
 const directory=await mkdtemp(join(tmpdir(),'dot-map-model-'));let now=100*86_400_000;
 const cache=new GeographicCache(directory,{now:()=>now});
 const updates:GeographyUpdate[]=[];
 const calls:{options:Parameters<typeof acquireGeography>[0];resolve:(d:GeographicDataset,complete?:boolean)=>void;reject:(e:Error)=>void}[]=[];
 const acquire:typeof acquireGeography=options=>new Promise((resolve,reject)=>calls.push({options,resolve:(data,complete=true)=>resolve({dataset:data,complete,stats:{downloadedBytes:0,cacheBytes:0}}),reject}));
 const resolver=new GeographicResolver({cache,now:()=>now,acquire,output:r=>updates.push(r)});
 return {directory,cache,updates,calls,resolver,advance:(ms:number)=>{now+=ms},close:async()=>{resolver.stop();await new Promise(resolve=>setTimeout(resolve,5));await rm(directory,{recursive:true,force:true});}};
}

test('first visit stays pending immediately and resolves partial then complete geographic evidence',async()=>{
 const s=await setup();try {
  s.resolver.update(first);assert.equal(s.updates.at(-1)?.state,'pending');assert.equal(s.updates.at(-1)?.evidence,undefined);
  await until(()=>s.calls.length===1);s.calls[0].options.progress!(dataset());
  assert.equal(s.updates.at(-1)?.state,'pending');assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Reference peak');
  s.calls[0].resolve(dataset());await until(()=>s.updates.at(-1)?.state==='ready');
  assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].distance_m,0);
 }finally{await s.close();}
});

test('completion measures against the latest fix within the region, not the acquisition-start coordinate',async()=>{
 const s=await setup();try {
  s.resolver.update(first);await until(()=>s.calls.length===1);
  const moved={...first,longitude:.006};s.resolver.update(moved);s.calls[0].resolve(dataset(moved));
  await until(()=>s.updates.at(-1)?.state==='ready');assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].distance_m,0);assert.deepEqual(s.updates.at(-1)?.fix,moved);
 }finally{await s.close();}
});

test('movement to another region fences old progress and queues only the latest requested area',async()=>{
 const s=await setup();try {
  s.resolver.update(first);await until(()=>s.calls.length===1);s.resolver.update(distant);
  s.calls[0].options.progress!(dataset(first,'Old area'));assert.equal(s.updates.at(-1)?.evidence,undefined);
  s.calls[0].resolve(dataset(first,'Old area'));await until(()=>s.calls.length===2);
  assert.equal(s.calls[1].options.region.key,geographicRegion(distant)!.key);
  s.calls[1].resolve(dataset(distant,'Current area'));await until(()=>s.updates.at(-1)?.state==='ready');
  assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Current area');
 }finally{await s.close();}
});

test('stopping aborts acquisition and suppresses every late progress/completion without persisting a region',async()=>{
 const s=await setup();try {
  s.resolver.update(first);await until(()=>s.calls.length===1);s.resolver.stop();const count=s.updates.length;
  assert.equal(s.calls[0].options.signal.aborted,true);s.calls[0].options.progress!(dataset());s.calls[0].resolve(dataset());
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(s.updates.length,count);assert.deepEqual(await readdir(s.directory),[]);
 }finally{await s.close();}
});

test('returning to a cached area is immediate even while another region is downloading',async()=>{
 const s=await setup();try {
  await s.cache.put(`normalized-${geographicRegion(first)!.key}`,Buffer.from(JSON.stringify(dataset(first,'Home area'))));
  s.resolver.update(first);await until(()=>s.updates.at(-1)?.state==='ready');
  s.resolver.update(distant);await until(()=>s.calls.length===1);s.resolver.update(first);
  await until(()=>s.updates.at(-1)?.state==='ready');assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Home area');
  s.calls[0].options.progress!(dataset(distant,'Other area'));s.calls[0].resolve(dataset(distant,'Other area'));
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Home area');assert.equal(s.calls.length,1);
 }finally{await s.close();}
});

test('offline interruption preserves partial references, bounds retries, and recovers without a user download action',async()=>{
 const s=await setup();try {
  s.resolver.update(first);await until(()=>s.calls.length===1);s.calls[0].options.progress!(dataset());s.calls[0].reject(new Error('offline'));
  await until(()=>s.updates.at(-1)?.state==='partial');assert.ok(s.updates.at(-1)?.evidence);
  s.resolver.update(first);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(s.calls.length,1);
  s.advance(61_000);s.resolver.update(first);await until(()=>s.calls.length===2);s.calls[1].resolve(dataset(first,'Recovered'));
  await until(()=>s.updates.at(-1)?.state==='ready');assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Recovered');
 }finally{await s.close();}
});

test('cache freshness is independent of repeated use and stale evidence remains identifiable during refresh',async()=>{
 const s=await setup();try {
  const key=`normalized-${geographicRegion(first)!.key}`;await s.cache.put(key,Buffer.from(JSON.stringify(dataset(first,'Old map'))));
  s.advance(8*86_400_000);await s.cache.get(key);s.resolver.update(first);
  await until(()=>s.calls.length===1);assert.equal(s.updates.at(-1)?.state,'stale');assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Old map');
  s.calls[0].resolve(dataset(first,'New map'));await until(()=>s.updates.at(-1)?.state==='ready');assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'New map');
 }finally{await s.close();}
});

test('empty coverage is a completed lookup, while unsupported coordinates never start a download',async()=>{
 const s=await setup();try {
  s.resolver.update({...first,latitude:89});assert.equal(s.updates.at(-1)?.state,'unavailable');assert.equal(s.calls.length,0);
  s.resolver.update(first);await until(()=>s.calls.length===1);s.calls[0].resolve({...dataset(),features:[]});
  await until(()=>s.updates.at(-1)?.state==='ready');assert.deepEqual(s.updates.at(-1)?.evidence?.landmarks,[]);
 }finally{await s.close();}
});

test('stale complete evidence is never replaced by a partial or failed refresh',async()=>{
 const s=await setup();try {
  await s.cache.put(`normalized-${geographicRegion(first)!.key}`,Buffer.from(JSON.stringify(dataset(first,'Complete old map'))));
  s.advance(8*86_400_000);s.resolver.update(first);await until(()=>s.calls.length===1);
  const revision=s.updates.at(-1)?.revision;
  s.calls[0].options.progress!({...dataset(),features:[]});
  assert.equal(s.updates.at(-1)?.state,'stale');assert.equal(s.updates.at(-1)?.revision,revision);
  s.calls[0].reject(new Error('offline'));await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(s.updates.at(-1)?.state,'stale');assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Complete old map');
 }finally{await s.close();}
});

test('cell-edge jitter preserves the acquisition, but genuine movement cancels it',async()=>{
 const s=await setup();try {
  s.resolver.update({...first,longitude:.0199});await until(()=>s.calls.length===1);
  s.resolver.update({...first,longitude:.0201});assert.equal(s.calls[0].options.signal.aborted,false);
  s.resolver.update({...first,longitude:.025});assert.equal(s.calls[0].options.signal.aborted,true);
  s.calls[0].reject(new Error('aborted'));await until(()=>s.calls.length===2);
  s.calls[1].resolve(dataset({...first,longitude:.025}));await until(()=>s.updates.at(-1)?.state==='ready');
 }finally{await s.close();}
});

test('partial evidence survives repeated failed retries and retry delay increases instead of spinning',async()=>{
 const s=await setup();try {
  s.resolver.update(first);await until(()=>s.calls.length===1);s.calls[0].resolve(dataset(first,'Retained partial map'),false);
  await until(()=>s.updates.at(-1)?.state==='partial');const revision=s.updates.at(-1)?.revision;
  s.advance(61_000);s.resolver.update(first);await until(()=>s.calls.length===2);
  s.calls[1].options.progress!({...dataset(),features:[]});
  assert.equal(s.updates.at(-1)?.state,'partial');assert.equal(s.updates.at(-1)?.revision,revision);
  s.calls[1].reject(new Error('still unavailable'));await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Retained partial map');
  s.advance(61_000);s.resolver.update(first);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(s.calls.length,2);
  s.advance(60_000);s.resolver.update(first);await until(()=>s.calls.length===3);s.calls[2].resolve(dataset(first,'Complete map'));
  await until(()=>s.updates.at(-1)?.state==='ready');assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Complete map');
 }finally{await s.close();}
});

test('a continuously used stationary region still refreshes when its map ages',async()=>{
 const s=await setup();try {
  s.resolver.update(first);await until(()=>s.calls.length===1);s.calls[0].resolve(dataset(first,'Initial map'));
  await until(()=>s.updates.at(-1)?.state==='ready');
  // ready is emitted before the asynchronous cache write settles. Advancing the
  // fake clock after a fixed delay races that write on a loaded CI host.
  assert.ok(await s.cache.get(`normalized-${geographicRegion(first)!.key}`));
  s.advance(8*86_400_000);s.resolver.update(first);await until(()=>s.calls.length===2);
  assert.equal(s.updates.at(-1)?.state,'stale');assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Initial map');
  s.calls[1].resolve(dataset(first,'Refreshed map'));await until(()=>s.updates.at(-1)?.state==='ready');
  s.resolver.update(first);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(s.calls.length,2);
 }finally{await s.close();}
});

for(const settles of ['reject','resolve'] as const)test(`returning A to B to A restarts cancelled acquisition after ${settles} without failure backoff`,async()=>{
 const s=await setup();try {
  s.resolver.update(first);await until(()=>s.calls.length===1);
  s.resolver.update(distant);s.resolver.update(first);
  assert.equal(s.calls[0].options.signal.aborted,true);
  const count=s.updates.length;s.calls[0].options.progress!(dataset(first,'Cancelled'));
  assert.equal(s.updates.length,count);
  if(settles==='reject')s.calls[0].reject(new Error('aborted'));else s.calls[0].resolve(dataset(first,'Cancelled'));
  await until(()=>s.calls.length===2);
  assert.equal(s.updates.some(update=>update.state==='unavailable'),false);
  assert.equal(s.calls[1].options.region.key,geographicRegion(first)!.key);
  s.calls[1].resolve(dataset(first,'Resumed'));await until(()=>s.updates.at(-1)?.state==='ready');
  assert.equal(s.updates.at(-1)?.evidence?.landmarks[0].name,'Resumed');
 }finally{await s.close();}
});
