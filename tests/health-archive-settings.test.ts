import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HealthContext } from '../server/health/context.ts';
import { HealthVault } from '../server/health/vault.ts';
import { ArchiveAuthority } from '../server/history/archive-authority.ts';
import { archiveSettings, archiveTerms, changeArchiveSettings } from '../server/history/archive-controls.ts';
import { WebhookSender } from '../server/webhook.ts';

test('one duration belongs to the paired owner; acquiring it for health never enrolls another source', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-history-period-'));
  const owner = 'a'.repeat(64), other = 'b'.repeat(64), now = Date.now();
  const wrappingKey = randomBytes(32), healthKey = randomBytes(32);
  const authority = new ArchiveAuthority(join(dir, 'archives'), {
    create: async () => ({key: Buffer.from(wrappingKey), wrapped:'fixture'}), open:async () => Buffer.from(wrappingKey),
  }, {ownerStatus:()=> 'authorized', now:()=>now});
  const path = join(dir, 'polar.enc');
  new HealthVault(path).write(healthKey, {version:1,enabled:true,owner,deletedBefore:0,profileDeleted:false,
    connection:{clientId:'fixture',clientSecret:'fixture',accessToken:'fixture',userId:1,expiresAt:now+86_400_000},observations:[]});
  const health = new HealthContext(path, {now:()=>now, key:async () => Buffer.from(healthKey),
    archivePeriod:id=>authority.periodFor(id), ownerAuthorized:()=>true,ownerRevoked:()=>false,
    sender:new WebhookSender(async()=>{throw Error('No notification expected');}), hosts:[], announce:async()=>({})});
  t.after(()=>{health.close();authority.close();healthKey.fill(0);wrappingKey.fill(0);rmSync(dir,{recursive:true,force:true});});
  const status = async () => ({polarEpoch:undefined as string|undefined,...await archiveSettings(authority,owner,health)});
  const start = await status();
  const select = {action:'set',source:'polar',enabled:true};
  const enable = {protocol:1,terms:archiveTerms,epoch:start.epoch,polarEpoch:start.polarEpoch,change:select};
  await assert.rejects(changeArchiveSettings(authority, owner, {...enable, terms:undefined}, health));
  await assert.rejects(changeArchiveSettings(authority, other, enable, health));
  assert.equal(authority.periodFor(owner), undefined);
  await changeArchiveSettings(authority, owner, enable, health);
  const active = await status();
  assert.equal(authority.periodFor(owner),'7d');
  assert.deepEqual(active.sources,{weather:false,mobility:false,polar:true});
  assert.equal(authority.periodFor(other),undefined);
  const longer = {protocol:1,terms:archiveTerms,epoch:active.epoch,change:{action:'period',period:'1y'}};
  await changeArchiveSettings(authority,owner,longer,health);
  assert.equal(authority.periodFor(owner),'1y');
  await assert.rejects(changeArchiveSettings(authority,owner,enable,health));
  const latest = await status();
  await changeArchiveSettings(authority,owner,{protocol:1,epoch:latest.epoch,polarEpoch:latest.polarEpoch,change:{action:'delete',source:'polar'}},health);
  assert.equal((await health.archiveStatus(owner)).enabled,false);
  assert.equal(health.status(owner).healthEnabled,true);
});
