import { closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The lock spans every companion checkpoint and the primary v1 vault rename.
// No consent, member or request information is written into the lock database.
export function lockHealthControl(directory: string, create = false, waitMs: 0 | 3000 = 3000) {
  if (!lstatSync(directory,{throwIfNoEntry:false}) && !create) return;
  if(create)mkdirSync(directory,{recursive:true,mode:0o700});
  const dir=lstatSync(directory);
  if(!dir.isDirectory()||(dir.mode&0o077))throw new Error('HEALTH_STORAGE_UNAVAILABLE');
  const path=join(directory,'control.lock');
  for(const suffix of ['','-journal','-wal','-shm']){
    const info=lstatSync(path+suffix,{throwIfNoEntry:false});
    if(info&&(!info.isFile()||info.nlink!==1))throw new Error('HEALTH_STORAGE_UNAVAILABLE');
  }
  closeSync(openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600));
  const lock=new DatabaseSync(path);
  try{lock.exec(`PRAGMA busy_timeout=${waitMs}; BEGIN IMMEDIATE`);}
  catch(error){lock.close();throw error;}
  return ()=>{try{lock.exec('ROLLBACK');}finally{lock.close();}};
}
