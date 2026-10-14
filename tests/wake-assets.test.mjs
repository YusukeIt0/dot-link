import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('preparation recovers known interrupted writes but rejects unrelated assets', async t => {
  const root=await mkdtemp(join(tmpdir(),'dot-wake-assets-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const path of ['scripts/lib','distribution/wake','public/wake-assets'])await mkdir(join(root,path),{recursive:true});
  for(const path of ['scripts/prepare-wake-assets.mjs','scripts/lib/wake-assets.mjs'])await cp(new URL('../'+path,import.meta.url),join(root,path));
  const bytes=Buffer.from('test runtime');
  await writeFile(join(root,'distribution/wake/runtime.js'),bytes);
  await writeFile(join(root,'distribution/wake/manifest.json'),JSON.stringify({files:{'runtime.js':{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),local:'runtime.js'}}}));
  await writeFile(join(root,'public/wake-assets/runtime.js.tmp-1234'),'interrupted');
  const run=()=>spawnSync(process.execPath,['scripts/prepare-wake-assets.mjs'],{cwd:root,encoding:'utf8'});
  const first=run();assert.equal(first.status,0,first.stderr);
  assert.deepEqual(await readdir(join(root,'public/wake-assets')),['runtime.js']);
  assert.deepEqual(await readFile(join(root,'public/wake-assets/runtime.js')),bytes);
  assert.deepEqual(await readdir(join(root,'.runtime/wake-assets-cache')),[]);
  await writeFile(join(root,'public/wake-assets/unrelated.txt'),'retain');
  assert.notEqual(run().status,0);
  assert.equal(await readFile(join(root,'public/wake-assets/unrelated.txt'),'utf8'),'retain');
});
