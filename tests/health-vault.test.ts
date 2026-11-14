import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HealthVault, healthKeychain } from '../server/health/vault.ts';
import { normalize, normalizeProfile, RETENTION } from '../server/health/data.ts';

test('encrypted snapshot roundtrip, restart, tampering and wrong key; no plaintext sidecar',()=>{
  const dir=mkdtempSync(join(tmpdir(),'health-vault-'));try {
    const path=join(dir,'health.enc'),key=randomBytes(32),store=new HealthVault(path);
    const value={profile:{date_of_birth:'1991-05-23',weight_kg:71.2},token:'private-polar-token',owner:'private-owner'};
    store.write(key,value);const bytes=readFileSync(path);
    for(const text of ['1991-05-23','71.2','private-polar-token','private-owner'])assert.equal(bytes.includes(Buffer.from(text)),false);
    assert.deepEqual(new HealthVault(path).read(key),value);assert.deepEqual(readdirSync(dir),['health.enc']);
    assert.throws(()=>store.read(randomBytes(32)));const damaged=Buffer.from(bytes);damaged[damaged.length-1]^=1;writeFileSync(path,damaged);assert.throws(()=>store.read(key));
    writeFileSync(path,bytes);store.write(key,value);assert.notDeepEqual(readFileSync(path),bytes);store.remove();assert.equal(store.exists(),false);
  }finally {rmSync(dir,{recursive:true,force:true});}
});
test('profile allowlist and original profile timestamp; no invented weight measurement time',()=>{
  const result=normalizeProfile({height:171,weight:70,birthday:'1990-02-03',modified:'2025-01-01T00:00:00Z',name:'private',gender:'MALE',extra:'instructions'},Date.parse('2026-11-14T00:00:00Z'));
  assert.equal(result.profile_modified_at,'2025-01-01T00:00:00Z');assert.equal(result.date_of_birth,'1990-02-03');assert.equal('name' in result,false);assert.equal('measured_at' in result,false);
});
test('measurement TTL uses source time, excludes delayed old sleeps and unknown fields',()=>{
  const now=Date.parse('2026-11-14T12:00:00Z');
  const sleep=(start:number)=>({sleep_start_time:new Date(start).toISOString(),sleep_end_time:new Date(start+3600_000).toISOString(),sleep_score:80,calories:900,device_id:'private'});
  assert.equal(normalize('sleep',{nights:[sleep(now-RETENTION)]},now).length,0);
  const rows=normalize('sleep',{nights:[sleep(now-86400_000)]},now);assert.equal(rows.length,1);assert.equal('calories' in rows[0].values,false);assert.equal(JSON.stringify(rows).includes('private'),false);
});
test('offset-free source dates never inherit the machine timezone',()=>{
  const now=Date.parse('2026-11-14T12:00:00Z');
  const [r]=normalize('heart_rate',[{date:'2026-11-14',heart_rate_samples:[{sample_time:'02:00:00',heart_rate:62}]}],now);
  assert.equal(r.measured_at,null);assert.equal(r.time_basis,'local_date_earliest_bound');assert.equal(r.retention_anchor,Date.parse('2026-11-13T10:00:00Z'));
});

 test('interactive Keychain authorization survives a normal human response delay',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'health-key-wait-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const helper=join(dir,'helper');
 writeFileSync(helper,'#!'+process.execPath+'\nsetTimeout(()=>process.stdout.write(JSON.stringify({status:"ok"})),16000);\n',{mode:0o700});
 assert.equal(await healthKeychain(helper)('authorize'),undefined);
 });
