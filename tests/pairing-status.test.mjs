import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairingStatus } from '../scripts/lib/pairing-status.mjs';
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'pairing-status-')); t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'.runtime/pairing/sessions'),{recursive:true});
 await mkdir(join(root,'.runtime/pairing/recoveries'),{recursive:true});return root;
}
const session='a'.repeat(64), recovery='b'.repeat(64);
const save=(root,kind,name,value)=>writeFile(join(root,'.runtime/pairing',kind,name+'.json'),JSON.stringify(value));
test('missing, expired and revoked pairing are not configured; inspection does not prune',async t=>{
 const root=await fixture(t);
 assert.deepEqual(await pairingStatus(root,100),{evenPairingKnown:true,evenPaired:false});
 await save(root,'sessions',session,{origin:'http://127.0.0.1:5555',expiresAt:99});
 assert.equal((await pairingStatus(root,100)).evenPaired,false);
 assert.ok(await readFile(join(root,'.runtime/pairing/sessions',session+'.json')));
 await save(root,'sessions',session,{origin:'http://127.0.0.1:5555',expiresAt:200,recoveryHash:recovery});
 assert.equal((await pairingStatus(root,100)).evenPaired,false);
});
test('current recovered pairing is configured; stale and foreign sessions are excluded',async t=>{
 const root=await fixture(t);
 await save(root,'sessions',session,{origin:'http://127.0.0.1:5555',expiresAt:200,recoveryHash:recovery});
 await save(root,'recoveries',recovery,{currentSession:session,expiresAt:200});
 assert.deepEqual(await pairingStatus(root,100),{evenPairingKnown:true,evenPaired:true});
 await save(root,'recoveries',recovery,{currentSession:'c'.repeat(64),expiresAt:200});
 assert.equal((await pairingStatus(root,100)).evenPaired,false);
 await save(root,'sessions',session,{origin:'https://example.com',expiresAt:200});
 assert.equal((await pairingStatus(root,100)).evenPaired,false);
});
test('unreadable records produce unknown instead of claiming unpaired',async t=>{
 const root=await fixture(t);
 await writeFile(join(root,'.runtime/pairing/sessions',session+'.json'),'{');
 assert.deepEqual(await pairingStatus(root,100),{evenPairingKnown:false,evenPaired:false});
});
