import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedService } from '../scripts/lib/service-management.mjs';
import { assertOwnedAgents } from '../scripts/lib/setup.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('service management refuses another installation even when its labels match',()=>{
  const root = '/Users/Example/Dot Link';
  const own = {Label:'local.even-g2-dot.device',WorkingDirectory:root,ProgramArguments:['/usr/local/bin/node',`${root}/server/device-main.ts`]};
  assert.equal(ownedService(own,root,'device'),true);
  assert.equal(ownedService({...own,WorkingDirectory:'/other'},root,'device'),false);
  assert.equal(ownedService({...own,ProgramArguments:['/other/app']},root,'device'),false);
  assert.equal(ownedService(own,root,'unknown'),false);
  assert.equal(ownedService({Label:'local.even-g2-dot.tunnel',WorkingDirectory:root,ProgramArguments:['tunnel-client','--profile-file',`${root}/.runtime/tunnel.yaml`]},root,'tunnel'),true);
});

test('setup refuses an occupied service before touching any existing files',async t=>{
  const destination=await mkdtemp(join(tmpdir(),'g2-services-'));
  t.after(()=>rm(destination,{recursive:true,force:true}));
  const path=join(destination,'local.even-g2-dot.device.plist');
  await writeFile(path,'original-other-install');
  const execute=async()=>JSON.stringify({Label:'local.even-g2-dot.device',WorkingDirectory:'/other',ProgramArguments:['node','/other/server/device-main.ts']});
  await assert.rejects(assertOwnedAgents('/new',{destination,execute}),/Another installation/);
  assert.equal(await readFile(path,'utf8'),'original-other-install');
  await assert.rejects(assertOwnedAgents('/new',{destination,execute:async()=>'{invalid'}),/Cannot verify/);
  assert.equal(await readFile(path,'utf8'),'original-other-install');
});
