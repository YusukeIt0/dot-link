import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verifyWakeAssets } from '../scripts/lib/wake-assets.mjs';

test(`packaged worker initializes ${process.env.DOT_TEST_WAKE_NAME ?? 'dot'} with real WASM/models offline and releases silent sessions`, async () => {
  const base=new URL('../public/wake-assets/',import.meta.url);
  await verifyWakeAssets(fileURLToPath(base));
  const messages: {type:string;generation?:number}[]=[];
  const host=globalThis as unknown as Record<string,unknown>;
  host.module={exports:{}};host.require=createRequire(import.meta.url);host.__dirname=fileURLToPath(base);
  host.postMessage=(message:{type:string})=>messages.push(message);
  host.fetch=async(url:string)=>{assert.ok(url.startsWith(base.href),'Detector must not fetch remote assets');return new Response(readFileSync(new URL(url)));};
  await import('../src/wake-worker.ts');
  const message=host.onmessage as (event:{data:object})=>Promise<void>;
  await message({data:{type:'init',assets:base.href,name:process.env.DOT_TEST_WAKE_NAME}});
  assert.deepEqual(messages,[{type:'ready'}]);
  for(let generation=1;generation<=3;generation++){
    await message({data:{type:'listen',generation}});
    for(let i=0;i<100;i++)await message({data:{type:'audio',generation,pcm:new Uint8Array(640),role:['self','other','unknown'][i%3]}});
    const processed=messages.filter(m=>m.type==='processed').length;
    await message({data:{type:'audio',generation:generation-1,pcm:new Uint8Array(640),role:'other'}});
    assert.equal(messages.filter(m=>m.type==='processed').length,processed,'stale audio is rejected');
    await message({data:{type:'cancel',generation:generation+1}});
  }
  assert.equal(messages.filter(m=>m.type==='processed').length,300);
  assert.ok(!messages.some(m=>['error','wake','clip'].includes(m.type)));
});
