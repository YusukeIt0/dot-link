import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Bridge} from '../server/bridge.ts';
import {bridgeServer} from '../server/http.ts';
import {WebhookSender} from '../server/webhook.ts';
import {HealthContext} from '../server/health/context.ts';
import {HealthVault} from '../server/health/vault.ts';

test('health setup is separate from device/MCP credentials; discovery and paired owner consent use existing transport',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'health-http-')),key=randomBytes(32),sender=new WebhookSender(async()=>({status:204,body:''}));
 const path=join(dir,'health.enc');new HealthVault(path).write(key,{version:1,enabled:false,deletedBefore:0,profileDeleted:false,observations:[],connection:{clientId:'fixture',clientSecret:'secret',accessToken:'private-token',userId:1,expiresAt:Date.now()+3600_000}});
 const owner='a'.repeat(64);const h=new HealthContext(path,{key:async()=>Buffer.from(key),ownerAuthorized:o=>o===owner,ownerRevoked:()=>false,announce:async()=>({}),sender,hosts:['example.com']});await h.setup({action:'status'});
 const bridge=new Bridge(join(dir,'bridge.json'),sender,['example.com']);
 const server=bridgeServer(bridge,{mcp:'mcp'.repeat(16),device:'device'.repeat(16),healthAdmin:'admin'.repeat(16)},undefined,undefined,undefined,undefined,undefined,h);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));h.close();bridge.close();rmSync(dir,{recursive:true,force:true});});
 const post=(route:string,token:string,body:unknown,headers={})=>fetch(base+route,{method:'POST',headers:{Authorization:`Bearer ${token.repeat(16)}`,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 for(const token of ['mcp','device'])assert.equal((await post('/api/health/setup',token,{action:'status'})).status,401);
 assert.equal((await post('/api/health/setup','admin',{action:'status'},{Origin:'https://evil.example'})).status,403);
 const setup=await (await post('/api/health/setup','admin',{action:'status'})).text();assert.equal(setup.includes('private-token'),false);assert.equal(setup.includes('secret'),false);
 const discover=await (await post('/mcp','mcp',{jsonrpc:'2.0',id:1,method:'tools/list'})).json();assert.ok(discover.result.tools.some((x:any)=>x.name==='get_health_context'));
 const epoch=h.status(owner).healthEpoch;
 assert.equal((await post('/api/health','device',{protocol:1,epoch,action:'delete'})).status,400);
 assert.equal((await post('/api/health','device',{protocol:1,epoch,action:'delete'},{'x-g2-location-owner':owner})).status,200);
});

test('loopback OAuth rejects wrong state/Host, consumes the code once and leaves sharing OFF',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'health-oauth-')),key=randomBytes(32),sender=new WebhookSender(async()=>({status:204,body:''}));
 const {PolarAPI}=await import('../server/health/polar.ts');const api=new PolarAPI();let exchanges=0;
 api.exchange=async client=>{exchanges++;return {...client,accessToken:'fixture-token',userId:12,expiresAt:Date.now()+3600_000};};
 const h=new HealthContext(join(dir,'health.enc'),{key:async()=>Buffer.from(key),api,ownerAuthorized:()=>true,ownerRevoked:()=>false,announce:async()=>({}),sender,hosts:[]});
 t.after(()=>{h.close();rmSync(dir,{recursive:true,force:true});});
 const setup=await h.setup({action:'connect',clientId:'fixture',clientSecret:'fixture-secret'});assert.ok('authorizationURL' in setup);
 const state=new URL(setup.authorizationURL).searchParams.get('state');
 const callback=(state:string,host='localhost:3464')=>fetch(`http://localhost:3464/polar/callback?code=fixture-code&state=${state}`,{headers:{Host:host}});
 assert.equal((await callback('wrong')).status,400);assert.equal(exchanges,0);
 // Host spoofing is rejected independently of OAuth state.
 const {request}=await import('node:http');
 const badHost=await new Promise<number>(resolve=>{const r=request(`http://127.0.0.1:3464/polar/callback?code=fixture-code&state=${state}`,{headers:{Host:'evil.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});r.end();});
 assert.equal(badHost,400);assert.equal(exchanges,0);
 assert.equal((await callback(state!)).status,200);assert.equal(exchanges,1);
 assert.equal(h.setupStatus().configured,true);assert.equal(h.setupStatus().sharing,false);assert.equal(h.read({}).status,'unavailable');
 try{await callback(state!);}catch{}assert.equal(exchanges,1);
});
