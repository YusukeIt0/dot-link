import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeographicCache } from '../server/geography/cache.ts';
const DAY = 86_400_000;

test('map cache reuses bytes, preserves acquisition age, rounds use days, and removes unused data after 30 days', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-map-cache-'));
  try {
    let now = 100 * DAY + 12345;
    const cache = new GeographicCache(directory, {now: () => now});
    await cache.put('public/source/release/range', new Uint8Array([1,2,3]));
    now += 29 * DAY;
    const hit = await cache.get('public/source/release/range');
    assert.deepEqual([...hit!.bytes], [1,2,3]); assert.equal(hit!.createdDay,100);
    const files = await readdir(directory); assert.equal(files.length,1);
    const info = await stat(join(directory,files[0]));
    assert.equal(info.mtimeMs, 129 * DAY); assert.equal(info.mode & 0o777,0o600);
    now += 30 * DAY;
    await cache.maintain(); assert.equal(await cache.get('public/source/release/range'),undefined);
    assert.equal((await readdir(directory)).length,0);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('bounded map cache evicts older days and does not activate aborted or oversized writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-map-cache-'));
  try {
    let now = 100 * DAY;
    const cache = new GeographicCache(directory, {now: () => now, maximumBytes:350,maximumEntryBytes:100});
    await cache.put('older',new Uint8Array(100)); now += DAY;
    await cache.put('newer',new Uint8Array(100));
    assert.equal(await cache.get('older'),undefined); assert.ok(await cache.get('newer'));
    await assert.rejects(cache.put('oversized',new Uint8Array(101)),/limit/);
    await assert.rejects(cache.put('aborted',new Uint8Array(2),AbortSignal.abort()));
    assert.equal(await cache.get('aborted'),undefined);
    assert.equal((await readdir(directory)).length,1);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('map cache refuses symlink content and ignores unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-map-cache-'));
  const other = await mkdtemp(join(tmpdir(), 'dot-map-cache-outside-'));
  try {
    const cache = new GeographicCache(directory);
    await cache.put('source',new Uint8Array([4]));
    const [name] = await readdir(directory);
    const target = join(other,name);
    const {writeFile} = await import('node:fs/promises');
    await writeFile(target,'outside'); await rm(join(directory,name)); await symlink(target,join(directory,name));
    await writeFile(join(directory,'unrelated'),'preserve');
    assert.equal(await cache.get('source'),undefined); await cache.maintain();
    assert.equal(await readFile(target,'utf8'),'outside');
    assert.equal(await readFile(join(directory,'unrelated'),'utf8'),'preserve');
  } finally { await rm(directory,{recursive:true,force:true}); await rm(other,{recursive:true,force:true}); }
});


test('map cache detects damaged bytes without returning them to the parser',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dot-map-corruption-'));
 try {
  const cache=new GeographicCache(directory);await cache.put('source',new Uint8Array([1,2,3]));
  const [name]=await readdir(directory);const path=join(directory,name);const data=await readFile(path);data[data.length-1]^=1;await writeFile(path,data);
  assert.equal(await cache.get('source'),undefined);
 }finally{await rm(directory,{recursive:true,force:true});}
});
