import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { decompressMapPage } from '../server/geography/compression.ts';

test('map decoder bounds actual output rather than trusting compressed page metadata',()=>{
 const raw=Buffer.alloc(100_000,7), compressed=zstdCompressSync(raw);
 assert.deepEqual(Buffer.from(decompressMapPage(compressed,raw.length)),raw);
 assert.throws(()=>decompressMapPage(compressed,10));
 assert.throws(()=>decompressMapPage(compressed,raw.length+1),/mismatch/);
 assert.throws(()=>decompressMapPage(compressed,17*1024*1024),/limit/);
 assert.throws(()=>decompressMapPage(compressed,Infinity),/limit/);
 assert.throws(()=>decompressMapPage(new Uint8Array([1,2,3]),10));
});
