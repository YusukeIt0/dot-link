import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PairingAuthority} from '../server/pairing-authority.ts';

// Exercise the production pair-action body with a packaged payload and an old
// writable installation. Only OS discovery and Tailscale are fixtures.
test('packaged Mac issues a usable code after revocation despite an older installation script',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dot-mac-pair-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const payload=join(root,'payload'),directory=join(root,'installation');
 await mkdir(join(payload,'scripts/lib'),{recursive:true});await mkdir(join(directory,'scripts'),{recursive:true});
 const repo=fileURLToPath(new URL('..',import.meta.url));
 for(const name of ['server','src','node_modules'])await symlink(join(repo,name),join(payload,name));
 await writeFile(join(payload,'package.json'),' {"type":"module"}');
 await copyFile(join(repo,'scripts/beta-pair.mjs'),join(payload,'scripts/beta-pair.mjs'));
 await writeFile(join(payload,'scripts/lib/setup.mjs'),"export async function tailscale(){return {origin:'https://fixture.tailtest.ts.net'}}");
 await writeFile(join(directory,'scripts/beta-pair.mjs'),"throw Error('STALE_INSTALLATION_SCRIPT_USED')");
 const authority=new PairingAuthority(join(directory,'.runtime/pairing'));
 authority.revokeAll();
 const source=await readFile(join(repo,'scripts/mac-setup.mjs'),'utf8');
 const body=source.split("} else if (action === 'pair') {")[1].split("} else throw new Error('UNKNOWN_ACTION')")[0];
 assert.ok(body);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const invoke=new AsyncFunction('inspect','run','payload','join','readFile',`let result; ${body}; return result;`);
 const execute=promisify(execFile);
 const args=[async()=>({step:'pair',directory}),async(file,args,options)=>(await execute(file,args,options)).stdout,payload,join,readFile];
 const oldBody=body.replace("join(payload, 'scripts/beta-pair.mjs')","join(state.directory, 'scripts/beta-pair.mjs')");
 const oldInvoke=new AsyncFunction('inspect','run','payload','join','readFile',`let result; ${oldBody}; return result;`);
 await assert.rejects(oldInvoke(...args),/STALE_INSTALLATION_SCRIPT_USED/);
 const result=await invoke(...args);
 const invitation=JSON.parse(result.pairingCode);
 const credentials=authority.exchange(invitation.code,'http://127.0.0.1:55001');
 assert.ok(credentials,'code issued through Mac action must be accepted by current relay');
 assert.equal(authority.authorized(credentials.token,'http://127.0.0.1:55001'),true);
 assert.equal(result.expiresAt,invitation.expiresAt);
});
