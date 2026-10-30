import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Mock only the Parquet parser boundary. The acquisition owner, cap admission,
// progress snapshots and cancellation below are the production implementation.
if (!process.env.DOTLINK_GEOGRAPHY_PARSER_TEST) {
 test('acquisition publishes bounded partial evidence and preserves final admission order',()=>{
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--test',fileURLToPath(import.meta.url)],{
   env:{...process.env,DOTLINK_GEOGRAPHY_PARSER_TEST:'1'},encoding:'utf8',timeout:20_000,
  });
  assert.equal(child.status,0,child.stdout+child.stderr);
 });
} else {
 const { mock }=await import('node:test');
 const { mkdtemp,rm }=await import('node:fs/promises');
 const { tmpdir }=await import('node:os');
 const { join }=await import('node:path');
 const release='2026-10-21.0';let clock=0,abortAt=-1,controller;
 const fixtureRows=[
  {id:'first',class:'footway',subtype:'road',names:{primary:'First path'},geometry:{type:'LineString',coordinates:[[0,0],[.001,.001]]}},
  {id:'second',class:'footway',subtype:'road',names:{primary:'Second path'},geometry:{type:'LineString',coordinates:[[.002,.002],[.003,.003]]}},
  {id:'third',class:'footway',subtype:'road',names:{primary:'Third path'},geometry:{type:'LineString',coordinates:[[.004,.004],[.005,.005]]}},
 ];
 mock.module('hyparquet',{namedExports:{
  parquetMetadataAsync:async()=>({row_groups:[],schema:[],num_rows:0}),
  parquetReadObjects:async()=>[{type:'Feature',collection:'segment',bbox:{xmin:0,xmax:.01,ymin:0,ymax:.01},assets:{azure:{
   href:`https://overturemapswestus2.blob.core.windows.net/release/${release}/theme=transportation/type=segment/part-test.zstd.parquet`,'file:size':100,
  }}}],
  parquetScan:async()=>({ranges:fixtureRows.map((_,i)=>({rowStart:i,rowEnd:i+1})),readColumn:async({rowStart,column})=>{
   if(column==='geometry') {clock+=1100;if(rowStart===abortAt)controller.abort();}
   return column==='bbox'?[{xmin:0,xmax:.01,ymin:0,ymax:.01}]:[fixtureRows[rowStart][column]];
  }}),
 }});
 const { acquireGeography,geographicRegion }=await import('../server/geography/overture.ts');
 const { GeographicCache }=await import('../server/geography/cache.ts');
 async function run(abort=-1){
  const directory=await mkdtemp(join(tmpdir(),'dot-geography-publication-'));
  controller=new AbortController();clock=0;abortAt=abort;const publications=[];
  try {
   const result=await acquireGeography({region:geographicRegion({latitude:.005,longitude:.005,accuracy:5}),
    cache:new GeographicCache(directory),signal:controller.signal,now:()=>clock,
    request:async url=>new Response(String(url).endsWith('catalog.json')?JSON.stringify({latest:release}):'catalog'),
    progress:data=>publications.push(data),
   });return {result,publications};
  }catch(error){return {error,publications};}
  finally {await rm(directory,{recursive:true,force:true});}
 }
 test('later row groups publish growing snapshots; final data order and limitations remain stable',async()=>{
  const {result,publications,error}=await run();assert.equal(error,undefined);assert.equal(result.complete,true);
  assert.deepEqual(publications.slice(0,3).map(d=>d.features.map(f=>f.id)),[
   ['segment:first'],['segment:first','segment:second'],['segment:first','segment:second','segment:third'],
  ]);
  assert.ok(publications.slice(0,3).every(d=>d.limitations.some(x=>x.includes('still loading'))));
  assert.deepEqual(result.dataset.features.map(f=>f.id),['segment:first','segment:second','segment:third']);
  assert.ok(result.dataset.limitations.every(x=>!x.includes('still loading')));
  assert.equal(publications[0].features.length,1); // Later admission does not mutate prior snapshots.
 });
 test('cancellation during a column read cannot publish that group or claim completion',async()=>{
  const {error,result,publications}=await run(1);assert.equal(result,undefined);assert.equal(error.name,'AbortError');
  assert.equal(publications.length,1);assert.deepEqual(publications[0].features.map(f=>f.id),['segment:first']);
 });
}
