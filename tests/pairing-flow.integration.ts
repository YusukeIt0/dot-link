import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { deviceServer } from '../server/device.ts';
import { RelaySettings } from '../src/relay-connection.ts';
import { parseInvite } from '../src/relay-origin.ts';
test('Mac-first copied code reaches relay directly and retained credentials reconnect', async t=>{
 const root=await mkdtemp(join(tmpdir(),'g2-code-flow-'));
 const authority=new PairingAuthority(join(root,'pairing'));
 const relay=deviceServer({token:'m'.repeat(43),origin:'https://mac.tailtest.ts.net',directory:root,pairing:authority,transcribe:async()=> 'synthetic test'});
 relay.listen(0,'127.0.0.1'); await once(relay,'listening');
 t.after(async()=>{relay.closeAllConnections();await new Promise<void>(r=>relay.close(()=>r()));await rm(root,{recursive:true,force:true});});
 const relayAddress=relay.address();assert(relayAddress && typeof relayAddress!=='string');
 // The Mac creates its self-contained code before the phone is opened.
 const invite=authority.issue('https://mac.tailtest.ts.net');
 const copied=JSON.stringify(invite);
 // Pasting supplies the destination and secret directly; no directory request.
 const source='http://127.0.0.1:55300';
 const resolved=parseInvite(copied);assert.deepEqual(resolved,invite);
 const call=(path:string,body:string,token?:string)=>new Promise<{status:number;body:any}>((resolve,reject)=>{
  const q=request({host:'127.0.0.1',port:relayAddress.port,path,method:'POST',headers:{Host:'mac.tailtest.ts.net',Origin:source,'Content-Type':token?'audio/wav':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}},res=>{const chunks:Buffer[]=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));});q.on('error',reject);q.end(body);
 });
 const pairing=await call('/api/pair',JSON.stringify({code:resolved.code}));assert.equal(pairing.status,200);
 const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
 assert.equal(new RelaySettings(()=>storage).save({...pairing.body,origin:resolved.origin}),true);
 const reopened=new RelaySettings(()=>storage).read()!;assert.ok(reopened);
 const received=await call('/api/transcribe','test-only-data',reopened.token);assert.equal(received.status,200);
 assert.equal((await call('/api/pair',JSON.stringify({code:resolved.code}))).status,401);
});
