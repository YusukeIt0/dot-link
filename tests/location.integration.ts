import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { Bridge } from '../server/bridge.ts';
import { bridgeServer } from '../server/http.ts';
import { deviceServer } from '../server/device.ts';
import { LocationContext } from '../server/location.ts';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { WebhookSender } from '../server/webhook.ts';

async function listen(server: Server) {server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;}
const post = (url: string, headers: Record<string, string>, body: unknown) => new Promise<{status: number; data: any}>((resolve, reject) => {
  const req = request(url, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}}, res => {
    const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {const text = Buffer.concat(chunks).toString(); resolve({status: res.statusCode!, data: text ? JSON.parse(text) : null});});
  }); req.on('error', reject); req.end(JSON.stringify(body));
});

test('paired phone location reaches a distinct MCP context; token rotation works and revoke blocks future use', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dot-location-http-'));
  const servers: Server[] = [];
  t.after(async () => {for (const server of servers) {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));} rmSync(dir, {recursive: true, force: true});});
  writeFileSync(join(dir, 'index.html'), '<h1>Fixture</h1>');
  const hosts = ['callback.example.test'];
  const sender = new WebhookSender(async (_url, raw) => {const e = JSON.parse(raw); return {status: 200, body: JSON.stringify(e.type === 'verification' ? {challenge: e.challenge} : {})};});
  const bridge = new Bridge(join(dir, 'voice.json'), sender, hosts);
  const locations = new LocationContext(join(dir, 'location.json'), sender, hosts, (input, guard, context) => bridge.sendMessage(input, guard, context));
  const tokens = {device: randomBytes(32).toString('base64url'), mcp: randomBytes(32).toString('base64url')};
  const relay = bridgeServer(bridge, tokens, undefined, locations);
  servers.push(relay);
  const relayURL = await listen(relay);
  const pairing = new PairingAuthority(join(dir, 'pairing'));
  const origin = 'http://127.0.0.1:53001';
  const invite = pairing.issue('https://fixture.tailtest.ts.net');
  let session = pairing.exchange(invite.code, origin)!;
  const device = deviceServer({token: tokens.device, origin: 'https://g2.example', directory: dir, bridgeURL: relayURL, pairing,
    transcribe: async () => {throw new Error('Audio must not run');}});
  servers.push(device);
  const deviceURL = await listen(device);
  const headers = () => ({Host: 'g2.example', Origin: origin, Authorization: `Bearer ${session.token}`});
  const id = randomUUID(), enable = {sharing_id: id, enabled: true};
  assert.equal((await post(deviceURL + '/api/location/control', {...headers(), Authorization: 'Bearer invalid'}, enable)).status, 401);
  assert.equal((await post(deviceURL + '/api/location/control', {...headers(), Origin: 'https://evil.example'}, enable)).status, 403);
  assert.equal((await post(deviceURL + '/api/location/revoke', headers(), {})).status, 404);
  assert.equal((await post(deviceURL + '/api/location/control', headers(), enable)).status, 200);
  const fix = {latitude: 10, longitude: 20, accuracy: 5, measured_at: new Date().toISOString()};
  assert.equal((await post(deviceURL + '/api/location/update', {...headers(), 'X-G2-Location-Owner': 'f'.repeat(64)}, {sharing_id: id, sequence: 1, fix})).status, 200);
  const mcpHeaders = {Authorization: `Bearer ${tokens.mcp}`};
  const read = await post(relayURL + '/mcp', mcpHeaders, {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'get_location_context', arguments: {}}});
  assert.equal(read.data.result.structuredContent.context.latitude, 10);
  assert.equal((await post(relayURL + '/api/location/update', mcpHeaders, {sharing_id: id, sequence: 2, fix})).status, 401);
  const contextId = read.data.result.structuredContent.context.context_id;
  const invalid = await post(relayURL + '/mcp', mcpHeaders, {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'respond_to_location', arguments: {context_id: contextId, disposition: 'silent', text: 'Private test text'},
  }});
  assert.equal(invalid.status, 200);
  assert.equal(invalid.data.error.code, -32602);
  assert.deepEqual(invalid.data.error.data, {reason: 'text_not_allowed_for_silent'});
  assert.equal(JSON.stringify(invalid.data).includes('Private test text'), false);
  assert.equal(locations.status().locationDecisionAt, null);
  const announcement = await post(relayURL + '/mcp', mcpHeaders, {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'respond_to_location', arguments: {context_id: contextId, disposition: 'announce', text: 'Synthetic recommendation'}}});
  assert.equal(announcement.data.result.structuredContent.stored_for_g2, true);
  assert.equal(bridge.outboundHistory()[0].location_sharing_id, id);
  assert.ok(bridge.outboundHistory()[0].location_expires_at);
  assert.equal(bridge.pending().utterances.length, 0);
  const originalSubject = pairing.subject(session.token, origin);
  session = pairing.resume(session.resumeToken!, origin)!;
  assert.equal(pairing.subject(session.token, origin), originalSubject);
  assert.equal((await post(deviceURL + '/api/location/update', headers(), {sharing_id: id, sequence: 2, fix})).status, 200);
  assert.equal((await post(deviceURL + '/api/pair/revoke', headers(), {})).status, 204);
  assert.equal(locations.read().context, null);
  const stopped = await post(relayURL + '/mcp', mcpHeaders, {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'respond_to_location', arguments: {context_id: contextId, disposition: 'silent'},
  }});
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.data.error.data, {reason: 'sharing_inactive'});
  assert.equal((await post(deviceURL + '/api/location/update', headers(), {sharing_id: id, sequence: 3, fix})).status, 403); // Revocation closes this origin as well as its credential.
});
