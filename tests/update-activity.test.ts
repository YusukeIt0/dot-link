import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UpdateActivity} from '../server/update-activity.ts';
test('activity tracker loads in the shipped Node strip-only runtime and records counters without content',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dot-update-activity-'));
 const activity=new UpdateActivity(directory);t.after(async()=>{activity.close();await rm(directory,{recursive:true,force:true});});
 const state=async()=>JSON.parse(await readFile(join(directory,'update-activity.json'),'utf8'));
 assert.equal((await state()).active,0);
 const first=activity.begin(),second=activity.begin();assert.equal((await state()).active,2);
 first();first();assert.equal((await state()).active,1);second();assert.equal((await state()).active,0);
 assert.deepEqual(Object.keys(await state()).sort(),['active','at','lastClient']);
 assert.equal(activity.maintenance(),false);await writeFile(join(directory,'app-update.json'),'{}');assert.equal(activity.maintenance(),true);
});
