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
  const source = Buffer.alloc(1_000_000,17); let active=0, maximum=0,calls=0;
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
  assert.equal(download.stats.downloadedBytes,1_000_000); assert.equal(download.stats.cacheBytes,2_000_000);
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
