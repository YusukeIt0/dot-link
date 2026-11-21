// Verify a maintainer build dependency before any of its code runs.
import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function exists(path){try{await access(path);return true;}catch{return false;}}
function git(args,cwd){return spawnSync('git',args,{cwd,encoding:'utf8'});}

/**
 * Clone `ref` from `repository` into `directory` when absent, then require HEAD to equal the
 * pinned `commit`. With `clean`, tracked files must also be unmodified, so a reused cache cannot
 * run edited tooling. Fresh clones and cached checkouts get the same checks.
 */
export async function preparePinnedCheckout({name,repository,ref,commit,directory,clean=false}){
  if(!/^[0-9a-f]{40}$/.test(commit??''))throw new Error(`${name}: manifest must pin a full commit SHA`);
  if(!await exists(directory)){
    const cloned=spawnSync('git',['clone','--depth','1','--branch',ref,repository,directory],{stdio:'inherit'});
    if(cloned.status!==0)throw new Error(`${name}: clone failed`);
  }
  const head=git(['rev-parse','HEAD'],directory);
  if(head.status!==0||head.stdout.trim()!==commit)
    throw new Error(`${name}: checkout is ${head.stdout.trim()||'unknown'}, expected pinned ${commit}. Remove ${directory} only after reviewing why the reference changed.`);
  if(clean){
    const status=git(['status','--porcelain','--untracked-files=no'],directory);
    if(status.status!==0||status.stdout.trim())throw new Error(`${name}: tracked files differ from pinned ${commit}`);
  }
}
