import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Bridge } from '../server/bridge.ts';
import { WebhookSender } from '../server/webhook.ts';
import { LocationContext } from '../server/location.ts';
import { LocationHistoryStore } from '../server/history/store.ts';
import { bridgeServer } from '../server/http.ts';
import { deviceServer } from '../server/device.ts';

test('device gateway negotiates history, shares existing ingestion, isolates old peers and serves actual MCP contract', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'history-beta-http-'));
  const tokens = {device: randomBytes(32).toString('base64url'), mcp: randomBytes(32).toString('base64url')};
  const owner = createHash('sha256').update(tokens.device).digest('hex');
  let time = Date.now();
  const sender = new WebhookSender(async (_url, raw) => {const e = JSON.parse(raw); return {status: 200, body: JSON.stringify(e.type === 'verification' ? {challenge: e.challenge} : {})};});
  const bridge = new Bridge(join(directory, 'bridge.json'), sender, ['callback.example.test']);
  const store = new LocationHistoryStore(join(directory, 'history'), {now: () => time, ownerAuthorized: id => id === owner, announce: (input, guard) => bridge.sendMessage(input, guard)});
  const locations = new LocationContext(join(directory, 'location.json'), sender, [], (input, guard, context) => bridge.sendMessage(input, guard, context), () => time);
  const server = bridgeServer(bridge, tokens, undefined, locations, store);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as any).port;
  const gateway = deviceServer({token: tokens.device, origin: 'http://device.test', directory, bridgeURL: `http://127.0.0.1:${port}`, transcribe: async () => ''});
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening'); const devicePort = (gateway.address() as any).port;
  t.after(async () => {gateway.closeAllConnections(); gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, {recursive: true, force: true});});
  const device = (path: string, input?: unknown, token = tokens.device): Promise<Response> => new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${devicePort}${path}`, {method: input === undefined ? 'GET' : 'POST',
      headers: {Host: 'device.test', Origin: 'http://device.test', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}}, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {status: response.statusCode}))); response.on('error', reject);
    }); request.on('error', reject); request.end(input === undefined ? undefined : JSON.stringify(input));
  });
  const mcp = async (name: string, args: unknown = {}) => (await fetch(`http://127.0.0.1:${port}/mcp`, {method: 'POST', headers: {Authorization: `Bearer ${tokens.mcp}`, 'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})})).json() as Promise<any>;
  const initial = await device('/api/status'); const initialBody = await initial.json(); assert.equal(initial.status, 200, JSON.stringify(initialBody)); let state: any = initialBody; assert.equal(state.historyProtocol, 1); assert.equal(state.historyEnabled, false);
  assert.equal((await device('/api/location/history', {}, 'bad')).status, 401);
  const control = async (action: string, scenario?: string) => {
    const result = await device('/api/location/history', {protocol: 1, epoch: state.historyEpoch, action, ...(scenario ? {scenario} : {})});
    assert.equal(result.status, 200); state = await result.json();
  };
  await control('enable'); time += 1000;
  const sharing_id = randomUUID();
  assert.equal((await device('/api/location/control', {sharing_id, enabled: true})).status, 200);
  const fix = () => ({latitude: 10, longitude: 10, accuracy: 5, measured_at: new Date(time).toISOString()});
  // An old companion continues live sharing but cannot silently opt into history.
  assert.equal((await device('/api/location/update', {sharing_id, sequence: 1, fix: fix()})).status, 200);
  assert.equal((await mcp('get_location_history')).result.structuredContent.status, 'empty');
  time += 15_000;
  const history = {protocol: 1, epoch: state.historyEpoch, timezone: 'Etc/UTC', utc_offset_minutes: 0};
  assert.equal((await device('/api/location/update', {sharing_id, sequence: 2, fix: fix(), history})).status, 200);
  let read = (await mcp('get_location_history', {detail: 'observations'})).result.structuredContent;
  assert.equal(read.entries.length, 1); assert.equal(read.source, 'phone_location');
  // Optional history metadata must not break live fixes from a mixed-version peer.
  let sequence = 2;
  for (const invalid of [{...history, timezone: 'x'.repeat(81)}, {...history, protocol: 2}, null]) {
    time += 15_000;
    const response = await device('/api/location/update', {sharing_id, sequence: ++sequence, fix: fix(), history: invalid});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.accepted, true); assert.equal(result.historyCount, 1);
  }
  const withoutHistory = bridgeServer(bridge, tokens, undefined, locations);
  withoutHistory.listen(0, '127.0.0.1'); await once(withoutHistory, 'listening');
  try {
    time += 15_000;
    const response = await fetch(`http://127.0.0.1:${(withoutHistory.address() as any).port}/api/location/update`, {
      method: 'POST', headers: {Authorization: `Bearer ${tokens.device}`, 'Content-Type': 'application/json', 'x-g2-location-owner': owner},
      body: JSON.stringify({sharing_id, sequence: ++sequence, fix: fix(), history}),
    });
    assert.equal(response.status, 200); assert.equal((await response.json()).accepted, true);
  } finally { withoutHistory.closeAllConnections(); await new Promise<void>(resolve => withoutHistory.close(() => resolve())); }
  await device('/api/location/control', {sharing_id, enabled: false});
  assert.equal((await mcp('get_location_history')).result.structuredContent.status, 'available', 'recording stop leaves separately permitted past history readable');
  assert.equal((await device('/api/location/history', {protocol: 1, epoch: state.historyEpoch, action: 'simulate', scenario: 'walk'})).status, 400);
  read = (await mcp('get_location_history')).result.structuredContent;
  assert.equal(read.source, 'phone_location');
  await bridge.subscribe({name: 'utterance.created', arguments: {session_id: 'personal-g2'}, delivery: {mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64')}});
  const utterance_id = randomUUID(); await device('/api/utterances', {id: utterance_id, text: 'Which fictional road?'});
  assert.equal((await mcp('respond_to_history', {history_context_id: read.history_context_id, utterance_id, text: 'The fictional east road.'})).result.structuredContent.stored_for_g2, true);
  await control('disable');
  assert.equal((await mcp('get_location_history')).result.structuredContent.status, 'unavailable');
  assert.equal((await mcp('respond_to_history', {history_context_id: read.history_context_id, utterance_id, text: 'The fictional east road.'})).error.data.reason, 'history_access_changed');
  assert.equal((await device('/api/location/history', {protocol: 1, epoch: history.epoch, action: 'enable'})).status, 400);
  await control('enable'); assert.equal(state.historyCount, 1); await control('delete'); assert.equal(state.historyCount, 0);
});
