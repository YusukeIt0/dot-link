import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceServer } from '../server/device.ts';
import { request } from 'node:http';

async function fetch(url: string, options: {headers?:Record<string,string>;method?:string;body?:string} = {}) {
  return new Promise<{status:number;json:()=>Promise<unknown>}>((resolve, reject) => {
    const req = request(url, {headers:options.headers,method:options.method}, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status:response.statusCode!,json:async()=>JSON.parse(Buffer.concat(chunks).toString())}));
    });
    req.on('error', reject); req.end(options.body);
  });
}

test('device HTTP permits paired same-origin audio but excludes MCP, foreign origins, and file escapes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'g2-device-test-'));
  await writeFile(join(directory, 'index.html'), '<h1>Dot</h1>');
  await symlink('/etc/hosts', join(directory, 'escape.html'));
  let count = 0;
  const server = deviceServer({ token: 'a'.repeat(64), origin: 'https://g2.example', directory,
    transcribe: async wav => { count++; assert.equal(wav.toString(), 'test'); return 'テスト'; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, {recursive:true,force:true}); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Host: 'g2.example', Origin: 'https://g2.example', Authorization: `Bearer ${'a'.repeat(64)}`, 'Content-Type':'audio/wav' };
  assert.equal((await fetch(base + '/')).status, 403);
  assert.equal((await fetch(base + '/', {headers})).status, 200);
  assert.equal((await fetch(base + '/escape.html', {headers})).status, 404);
  assert.equal((await fetch(base + '/mcp', {headers,method:'POST'})).status, 405);
  assert.equal((await fetch(base + '/api/mcp', {headers,method:'POST'})).status, 404);
  assert.equal((await fetch(base + '/api/notifications', {headers,method:'POST',body:'{}'})).status, 404);
  assert.equal((await fetch(base + '/api/transcribe', {headers:{...headers,Origin:'https://evil.example'},method:'POST',body:'test'})).status, 403);
  assert.equal((await fetch(base + '/api/transcribe', {headers:{...headers,Authorization:'Bearer invalid'},method:'POST',body:'test'})).status, 401);
  const good = await fetch(base + '/api/transcribe', {headers,method:'POST',body:'test'});
  assert.equal(good.status, 200); assert.deepEqual(await good.json(), {text:'テスト'}); assert.equal(count, 1);
  assert.equal((await fetch(base + '/api/transcribe', {headers,method:'POST',body:'x'.repeat(960045)})).status, 400);
  assert.equal(count, 1);
});
