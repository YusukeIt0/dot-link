import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { deviceServer } from '../server/device.ts';
import { PairingAuthority } from '../server/pairing-authority.ts';

test('beta CORS, single-use exchange, session revocation, and legacy-key boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'g2-beta-http-')); let calls = 0;
  const pairing = new PairingAuthority(join(root, 'pairing'));
  const host = 'mac.tailtest.ts.net', app = 'http://127.0.0.1:54965', master = 'a'.repeat(43);
  const server = deviceServer({ token: master, origin: `https://${host}`, directory: root,
    pairing, appOrigins: [app], transcribe: async () => { calls++; return 'Hello'; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, {recursive:true,force:true}); });
  const invoke = (path: string, method: string, extra: Record<string,string> = {}, body = '') => new Promise<{status:number;headers:Record<string,unknown>;body:any}>((resolve, reject) => {
    const req = request({host:'127.0.0.1',port:address.port,path,method,headers:{Host:host,Origin:app,...extra}}, response => {
      const parts: Buffer[] = []; response.on('data', chunk => parts.push(chunk)); response.on('end', () => {
        const text = Buffer.concat(parts).toString(); resolve({status:response.statusCode!,headers:response.headers,body:text ? JSON.parse(text) : undefined});
      });
    }); req.on('error',reject); req.end(body);
  });
  const newSource = 'http://127.0.0.1:55002';
  assert.equal((await invoke('/api/pair', 'OPTIONS', {Origin:newSource,'Access-Control-Request-Method':'POST'})).status,403);
  const unbound = pairing.issue(`https://${host}`);
  assert.equal((await invoke('/api/pair', 'OPTIONS', {Origin:newSource,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'})).status,204);
  assert.equal((await invoke('/api/pair', 'OPTIONS', {Origin:newSource,'Access-Control-Request-Method':'GET'})).status,403);
  assert.equal((await invoke('/api/pair', 'OPTIONS', {Origin:newSource,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization'})).status,403);
  assert.equal((await invoke('/api/status', 'GET', {Origin:newSource})).status,403);
  assert.equal((await invoke('/api/pair', 'POST', {Origin:newSource,'Content-Type':'application/json'},JSON.stringify({code:'z'.repeat(43)}))).status,401);
  assert.equal((await invoke('/api/pair', 'POST', {Origin:newSource,'Content-Type':'application/json'},JSON.stringify({code:unbound.code}))).status,200);
  assert.equal((await invoke('/api/status', 'GET', {Origin:newSource})).status,401);
  const preflight = await invoke('/api/transcribe', 'OPTIONS', {'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,x-g2-trace-id'});
  assert.equal(preflight.status,204); assert.equal(preflight.headers['access-control-allow-origin'], app);
  assert.equal((await invoke('/api/transcribe','OPTIONS',{'Origin':'null','Access-Control-Request-Method':'POST'})).status,403);
  assert.equal((await invoke('/api/transcribe','OPTIONS',{'Access-Control-Request-Method':'DELETE'})).status,403);
  assert.equal((await invoke('/api/mcp','OPTIONS',{'Access-Control-Request-Method':'POST'})).status,403);
  assert.equal((await invoke('/api/status','GET',{Authorization:`Bearer ${master}`})).status,401);
  assert.equal((await invoke('/api/status','GET')).status,401);
  const invite = pairing.issue(`https://${host}`, app);
  const exchange = () => invoke('/api/pair','POST',{'Content-Type':'application/json'},JSON.stringify({code:invite.code}));
  const attempts = await Promise.all([exchange(),exchange()]);
  assert.deepEqual(attempts.map(result=>result.status).sort(), [200,401]);
  const {token} = attempts.find(result=>result.status===200)!.body;
  assert.notEqual(token,master);
  const auth = {Authorization:`Bearer ${token}`,'Content-Type':'audio/wav'};
  assert.equal((await invoke('/api/transcribe','POST',auth,'test')).status,200);
  assert.equal(calls,1);
  assert.equal((await invoke('/api/transcribe','POST',{...auth,Origin:'https://evil.example'},'test')).status,403);
  assert.equal((await invoke('/api/transcribe','POST',{...auth,Origin:'http://127.0.0.1:54966'},'test')).status,403);
  assert.equal((await invoke('/api/transcribe','POST',auth,'x'.repeat(960045))).status,400);
  assert.equal(calls,1);
  assert.equal((await invoke('/api/pair/revoke','POST',auth)).status,204);
  assert.equal((await invoke('/api/transcribe','POST',auth,'test')).status,401);
  assert.equal((await invoke('/api/pair','POST',{'Content-Type':'application/json'},JSON.stringify({code:'x'.repeat(43),other:1}))).status,400);
});
