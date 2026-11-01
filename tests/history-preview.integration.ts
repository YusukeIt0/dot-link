import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Bridge } from '../server/bridge.ts';
import { WebhookSender } from '../server/webhook.ts';
import { bridgeServer, rpc } from '../server/http.ts';
import { historyPreviewServer } from './history-preview-server.ts';
import { historyFixture } from './fixtures/location-history.ts';

test('isolated HTTP preview exposes only authenticated read-only history and no device/events', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-history-http-'));
  const path = join(directory, 'bridge.json');
  let callbacks = 0;
  const bridge = new Bridge(path, new WebhookSender(async () => { callbacks++; throw new Error('No network'); }), []);
  const baseline = readFileSync(path, 'utf8');
  const token = randomBytes(32).toString('base64url');
  const { history } = historyFixture('walk', Date.parse('2026-11-02T12:00:00Z'));
  const server = historyPreviewServer(bridge, token, history);
  t.after(() => { server.closeAllConnections(); server.close(); bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;
  const post = async (input: unknown, credential = token, endpoint = '/mcp', extra: Record<string, string> = {}) => fetch(url + endpoint,
    { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(input) });
  const input = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, params });
  assert.equal((await post(input('tools/list'), 'wrong')).status, 401);
  assert.equal((await post(input('tools/list'), token, '/mcp', { Origin: 'https://untrusted.test' })).status, 403);
  for (const path of ['/api/location/update', '/api/utterances', '/api/messages', '/api/status']) assert.equal((await post({}, token, path)).status, 404);
  const discovery: any = await (await post(input('initialize'))).json();
  assert.equal(discovery.result.serverInfo.name, 'dot-link-synthetic-history-preview');
  const listing: any = await (await post(input('tools/list'))).json();
  assert.deepEqual(listing.result.tools.map((tool: any) => tool.name), ['get_location_history']);
  const events: any = await (await post(input('events/list'))).json(); assert.deepEqual(events.result.events, []);
  for (const name of ['reply_to_g2', 'send_message_to_g2', 'get_location_context', 'missing']) {
    const result: any = await (await post(input('tools/call', { name, arguments: {} }))).json();
    assert.equal(result.error.code, -32601);
  }
  const subscribe: any = await (await post(input('events/subscribe', {}))).json(); assert.equal(subscribe.error.code, -32601);
  const result: any = await (await post(input('tools/call', { name: 'get_location_history', arguments: { detail: 'observations', limit: 2 } }))).json();
  assert.equal(result.result.structuredContent.entries.length, 2);
  assert.equal(result.result.structuredContent.source, 'synthetic_fixture');
  assert.deepEqual(JSON.parse(result.result.content[0].text), result.result.structuredContent);
  const invalid: any = await (await post(input('tools/call', { name: 'get_location_history', arguments: { start_at: 'sensitive' } }))).json();
  assert.equal(invalid.error.data.reason, 'invalid_arguments'); assert.equal(JSON.stringify(invalid).includes('sensitive'), false);
  history.setReadable(false);
  const revoked: any = await (await post(input('tools/call', { name: 'get_location_history', arguments: {} }))).json();
  assert.equal(revoked.result.structuredContent.status, 'unavailable');
  assert.equal(callbacks, 0); assert.equal(readFileSync(path, 'utf8'), baseline);
});

test('normal relay does not discover or enable history, even if a consumer retains its tool definition', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-history-legacy-'));
  const bridge = new Bridge(join(directory, 'bridge.json'), new WebhookSender(async () => { throw new Error('No network'); }), []);
  const token = randomBytes(32).toString('base64url');
  const server = bridgeServer(bridge, { mcp: token, device: randomBytes(32).toString('base64url') });
  t.after(() => { server.closeAllConnections(); server.close(); bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = async (method: string, params?: unknown): Promise<any> => (await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json();
  assert.equal((await call('tools/list')).result.tools.some((tool: any) => tool.name === 'get_location_history'), false);
  assert.equal((await call('tools/call', { name: 'get_location_history', arguments: {} })).error.data.reason, 'tool_unavailable');
  assert.equal((await call('tools/call', { name: 'get_status', arguments: {} })).result.structuredContent.messageCount, 0);
  const fixture = historyFixture('empty', Date.now());
  const injected: any = await rpc(bridge, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, undefined, undefined, fixture.history);
  assert.ok(injected.result.tools.some((tool: any) => tool.name === 'get_location_history'));
});
