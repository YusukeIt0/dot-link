import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { decompressMapPage, boundedMapCompressors } from '../server/geography/compression.ts';

test('map decoder bounds actual output rather than trusting compressed page metadata',()=>{
 const raw=Buffer.alloc(100_000,7), compressed=zstdCompressSync(raw);
 assert.deepEqual(Buffer.from(decompressMapPage(compressed,raw.length)),raw);
 assert.throws(()=>decompressMapPage(compressed,10));
 assert.throws(()=>decompressMapPage(compressed,raw.length+1),/mismatch/);
 assert.throws(()=>decompressMapPage(compressed,17*1024*1024),/limit/);
 assert.throws(()=>decompressMapPage(compressed,Infinity),/limit/);
 assert.throws(()=>decompressMapPage(new Uint8Array([1,2,3]),10));
});

test('individually valid pages cannot exceed a file cumulative expansion budget',()=>{
 const raw=Buffer.alloc(100_000,7),compressed=zstdCompressSync(raw),decoder=boundedMapCompressors(200_000).ZSTD;
 decoder(compressed,raw.length);decoder(compressed,raw.length);
 assert.throws(()=>decoder(compressed,raw.length),/limit/);
 assert.deepEqual(Buffer.from(boundedMapCompressors(200_000).ZSTD(compressed,raw.length)),raw);
});
