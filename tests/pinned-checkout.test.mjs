import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { preparePinnedCheckout } from '../scripts/lib/pinned-checkout.mjs';

const git=(cwd,...args)=>{const r=spawnSync('git',['-c','user.name=t','-c','user.email=t@example.invalid','-c','commit.gpgsign=false','-c','tag.gpgsign=false',...args],{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
async function upstream(t){
  const root=await mkdtemp(join(tmpdir(),'dot-pinned-checkout-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'upstream');git(root,'init','-q','-b','main',repo);
  // The tool would leave this marker if it ever ran; verification must stop first.
  await writeFile(join(repo,'tool.sh'),`#!/bin/sh\ntouch "${join(root,'tool-ran')}"\n`);
  git(repo,'add','.');git(repo,'commit','-q','-m','release');git(repo,'tag','4.0.23');
  return {root,repo,pinned:git(repo,'rev-parse','HEAD'),url:`file://${repo}`};
}
const ran=async root=>access(join(root,'tool-ran')).then(()=>true,()=>false);

test('a fresh clone at the pinned commit is accepted', async t => {
  const {root,pinned,url}=await upstream(t);
  const directory=join(root,'emsdk');
  await preparePinnedCheckout({name:'emsdk',repository:url,ref:'4.0.23',commit:pinned,directory,clean:true});
  assert.match(await readFile(join(directory,'tool.sh'),'utf8'),/tool-ran/);
});

test('a version tag moved to another commit stops before the tool can run', async t => {
  const {root,repo,pinned,url}=await upstream(t);
  await writeFile(join(repo,'tool.sh'),'#!/bin/sh\necho replaced\n');
  git(repo,'commit','-qam','retag');git(repo,'tag','-f','4.0.23');
  await assert.rejects(preparePinnedCheckout({name:'emsdk',repository:url,ref:'4.0.23',commit:pinned,directory:join(root,'emsdk'),clean:true}),/expected pinned/);
  assert.equal(await ran(root),false);
});

test('a cached checkout whose HEAD differs from the pin stops before reuse', async t => {
  const {root,repo,pinned,url}=await upstream(t);
  const directory=join(root,'emsdk');
  git(root,'clone','-q',url,directory);
  await writeFile(join(repo,'tool.sh'),'#!/bin/sh\necho newer\n');git(repo,'commit','-qam','newer');
  git(directory,'pull','-q');
  await assert.rejects(preparePinnedCheckout({name:'emsdk',repository:url,ref:'4.0.23',commit:pinned,directory,clean:true}),/expected pinned/);
});

test('a cached checkout at the pin with edited tracked tooling is rejected', async t => {
  const {root,pinned,url}=await upstream(t);
  const directory=join(root,'emsdk');
  await preparePinnedCheckout({name:'emsdk',repository:url,ref:'4.0.23',commit:pinned,directory,clean:true});
  await writeFile(join(directory,'tool.sh'),'#!/bin/sh\necho tampered\n');
  await assert.rejects(preparePinnedCheckout({name:'emsdk',repository:url,ref:'4.0.23',commit:pinned,directory,clean:true}),/tracked files differ/);
});

test('the wake manifest pins full commits for both executed sources', async () => {
  const manifest=JSON.parse(await readFile(new URL('../distribution/wake/manifest.json',import.meta.url),'utf8'));
  assert.match(manifest.sourceCommit,/^[0-9a-f]{40}$/);
  assert.match(manifest.emsdkCommit,/^[0-9a-f]{40}$/);
  await assert.rejects(preparePinnedCheckout({name:'emsdk',repository:'unused',ref:'x',commit:undefined,directory:'/nonexistent'}),/full commit SHA/);
});
