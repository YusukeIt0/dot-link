import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GeographicCache } from '../server/geography/cache.ts';
import { MapDownload, validMapURL } from '../server/geography/download.ts';
const URL = 'https://overturemapswestus2.blob.core.windows.net/release/2026-10-21.0/theme=base/type=land/part.parquet';

test('bounded range reader reuses only exact validated bytes and caps concurrency', async () => {
 const directory = await mkdtemp(join(tmpdir(),'dot-map-download-'));
 try {
  const source = Buffer.from(Array.from({length:1_000_000},(_,i)=>(i*17+Math.floor(i/251))%256)); let active=0, maximum=0,calls=0;
  const request = (async (_url: unknown, init: RequestInit) => {
   calls++; active++; maximum=Math.max(maximum,active);
   await new Promise(resolve=>setTimeout(resolve,2)); active--;
   const range=(init.headers as Record<string,string>).Range.match(/bytes=(\d+)-(\d+)/)!;
   const start=Number(range[1]),end=Number(range[2]);
   return new Response(source.subarray(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${source.length}`}});
  }) as typeof fetch;
  const download=new MapDownload(new GeographicCache(directory),new AbortController().signal,request);
  const file=await download.file(URL,source.length);
  assert.deepEqual(Buffer.from(await file.slice(10,900_000)),source.subarray(10,900_000));
  const count=calls; await file.slice(10,900_000);assert.deepEqual(Buffer.from(await file.slice(100,800_000)),source.subarray(100,800_000)); assert.equal(calls,count); assert.ok(maximum<=3);
  assert.deepEqual(Buffer.from(await file.slice(262143,262146)),source.subarray(262143,262146));
  assert.deepEqual(Buffer.from(await file.slice(999999)),source.subarray(999999));
  assert.equal(download.stats.downloadedBytes,1_000_000); assert.equal(download.stats.cacheBytes,2_000_000+524288+213568);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('source allowlist, range status, range identity, truncation, oversize and cancellation fail closed', async () => {
 const directory = await mkdtemp(join(tmpdir(),'dot-map-download-'));
 try {
  for(const url of ['http://stac.overturemaps.org/a','https://localhost/a','https://stac.overturemaps.org:444/a','https://user@stac.overturemaps.org/a','https://stac.overturemaps.org/a?q=b']) assert.throws(()=>validMapURL(url));
  const cases = [new Response('abcd'),new Response('abcd',{status:206,headers:{'Content-Range':'bytes 1-4/10'}}),new Response('ab',{status:206,headers:{'Content-Range':'bytes 0-9/10'}}),new Response('abcdefghijk',{status:206,headers:{'Content-Range':'bytes 0-9/10'}})];
  for (const response of cases) {
   const download=new MapDownload(new GeographicCache(directory),new AbortController().signal,(async()=>response) as typeof fetch);
   const file=await download.file(URL,10); await assert.rejects(file.slice(0,4));
  }
  let calls=0;
  const cancelled = new MapDownload(new GeographicCache(directory),AbortSignal.abort(),(async()=>{calls++;return new Response('x')}) as typeof fetch);
  await assert.rejects(cancelled.json('https://stac.overturemaps.org/catalog.json')); assert.equal(calls,0);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('adjacent misses use bounded combined requests while reusing existing individual cache chunks', async () => {
 const directory=await mkdtemp(join(tmpdir(),'dot-map-combined-'));
 try {
  const chunk=256*1024,source=Buffer.alloc(chunk*28+37);
  for(let i=0;i<source.length;i++)source[i]=(i*13+Math.floor(i/257))%256;
  const cache=new GeographicCache(directory),cachedIndex=3;
  await cache.put(`${URL}#${source.length}:${cachedIndex*chunk}:${(cachedIndex+1)*chunk}`,source.subarray(cachedIndex*chunk,(cachedIndex+1)*chunk));
  const ranges:{start:number;end:number}[]=[];let active=0,maximum=0;
  const request=(async(_url:unknown,init:RequestInit)=>{
   const match=(init.headers as Record<string,string>).Range.match(/^bytes=(\d+)-(\d+)$/)!;
   const start=Number(match[1]),end=Number(match[2])+1;
   ranges.push({start,end});active++;maximum=Math.max(maximum,active);
   await new Promise(resolve=>setTimeout(resolve,5));active--;
   return new Response(source.subarray(start,end),{status:206,headers:{'Content-Range':`bytes ${start}-${end-1}/${source.length}`}});
  }) as typeof fetch;
  const download=new MapDownload(cache,new AbortController().signal,request),file=await download.file(URL,source.length);
  assert.deepEqual(Buffer.from(await file.slice(7,source.length-3)),source.subarray(7,-3));
  assert.equal(download.stats.downloadedBytes,source.length-chunk);
  assert.equal(download.stats.cacheBytes,chunk);
  assert.equal(ranges.length,5); // A cached hole splits one of four windows.
  assert.ok(ranges.some(r=>r.end-r.start===2*1024*1024));
  assert.ok(ranges.every(r=>r.end-r.start<=2*1024*1024));
  assert.ok(ranges.every(r=>r.end<=cachedIndex*chunk||r.start>=(cachedIndex+1)*chunk));
  assert.ok(maximum>1&&maximum<=3);
  const offline=new MapDownload(new GeographicCache(directory),new AbortController().signal,(async()=>{throw new Error('offline');}) as typeof fetch);
  const reuse=await offline.file(URL,source.length);
  assert.deepEqual(Buffer.from(await reuse.slice(chunk-1,chunk*9+1)),source.subarray(chunk-1,chunk*9+1));
  assert.equal(offline.stats.downloadedBytes,0);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('concurrent combined reads share the global request cap and cancellation drains queued requests', async () => {
 const directory=await mkdtemp(join(tmpdir(),'dot-map-cancel-'));
 try {
  const controller=new AbortController();let calls=0,active=0,maximum=0;
  let saturated!:()=>void;const ready=new Promise<void>(resolve=>{saturated=resolve;});
  const request=(async(_url:unknown,init:RequestInit)=>{
   calls++;active++;maximum=Math.max(maximum,active);if(active===3)saturated();
   try {await new Promise((_,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));}
   finally {active--;}
   throw new Error('unreachable');
  }) as typeof fetch;
  const download=new MapDownload(new GeographicCache(directory),controller.signal,request);
  const file=await download.file(URL,32*1024*1024);
  const results=Promise.allSettled([file.slice(0,8*1024*1024),file.slice(8*1024*1024,16*1024*1024)]);
  await ready;controller.abort();
  assert.ok((await results).every(result=>result.status==='rejected'));
  assert.equal(calls,3);assert.equal(maximum,3);assert.equal(active,0);
  assert.equal(download.stats.downloadedBytes,0);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('invalid combined responses never populate reusable chunks', async () => {
 const directory=await mkdtemp(join(tmpdir(),'dot-map-invalid-combined-'));
 try {
  const size=1024*1024,cache=new GeographicCache(directory);
  const download=new MapDownload(cache,new AbortController().signal,(async()=>new Response(Buffer.alloc(size-1),{
   status:206,headers:{'Content-Range':`bytes 0-${size-1}/${size}`}
  })) as typeof fetch);
  const file=await download.file(URL,size);await assert.rejects(file.slice(0,size),/Truncated/);
  for(let start=0;start<size;start+=256*1024)assert.equal(await cache.get(`${URL}#${size}:${start}:${start+256*1024}`),undefined);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('combined acquisition retains transfer reservation and request-count budgets', async () => {
 const directory=await mkdtemp(join(tmpdir(),'dot-map-budgets-'));
 try {
  let calls=0;
  const documents=new MapDownload(new GeographicCache(directory),new AbortController().signal,(async()=>{calls++;return new Response('{}');}) as typeof fetch);
  for(let i=0;i<40;i++)await documents.document('https://stac.overturemaps.org/catalog.json');
  await assert.rejects(documents.document('https://stac.overturemaps.org/catalog.json'),/budget/);
  assert.equal(calls,40);
  calls=0;
  const ranges=new MapDownload(new GeographicCache(directory),new AbortController().signal,(async()=>{
   calls++;return new Response('12345678',{status:206,headers:{'Content-Range':'bytes 0-7/8'}});
  }) as typeof fetch);
  for(let i=0;i<500;i++){const file=await ranges.file(URL.replace('part.parquet',`part-${i}.parquet`),8);await file.slice(0,8);}
  const file=await ranges.file(URL.replace('part.parquet','part-over-limit.parquet'),8);
  await assert.rejects(file.slice(0,8),/budget/);assert.equal(calls,500);
 } finally {await rm(directory,{recursive:true,force:true});}
});
