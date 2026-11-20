import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rpc} from '../server/http.ts';
import {Bridge} from '../server/bridge.ts';
import {HealthVault} from '../server/health/vault.ts';
import {HealthContext} from '../server/health/context.ts';
import {normalize} from '../server/health/data.ts';
import {LocationHistoryStore} from '../server/history/store.ts';
import {WebhookSender} from '../server/webhook.ts';
import {readFactorHistory, type SelectedHistoryReader} from '../server/history/factor-tool.ts';

const owner = 'a'.repeat(64);
const now = Date.parse('2026-11-14T12:00:00Z');
const window = {start_at: '2026-11-10T00:00:00Z', end_at: '2026-11-11T00:00:00Z'};
const selection = {location: ['motion'], polar: ['steps']};

async function fixture(t: TestContext, polarOwner = owner) {
  t.mock.timers.enable({apis: ['Date'], now});
  const directory = mkdtempSync(join(tmpdir(), 'factor-history-'));
  const sender = new WebhookSender(async () => {throw new Error('No callback expected');});
  const bridge = new Bridge(join(directory, 'bridge.json'), sender, []);
  let clock = Date.parse('2026-11-08T00:00:00Z');
  const history = new LocationHistoryStore(join(directory, 'places'), {now: () => clock, ownerAuthorized: () => true,
    announce: bridge.sendMessage.bind(bridge)});
  const control = (action: string) => history.control({protocol: 1, epoch: history.status(owner).historyEpoch, action}, owner);
  control('enable');
  clock = now;
  const sharing = randomUUID();
  for (const time of ['2026-11-09T23:59:59.000Z', '2026-11-10T00:00:00.000Z', '2026-11-10T12:00:00.000Z', '2026-11-11T00:00:00.000Z']) {
    assert.ok(history.ingest({latitude: 12.125, longitude: 33.125, accuracy: 1, speed: 2, measured_at: time}, sharing,
      {protocol: 1, epoch: history.status(owner).historyEpoch, timezone: 'Etc/UTC', utc_offset_minutes: 0}, owner));
  }
  const key = randomBytes(32), path = join(directory, 'polar.enc');
  const activities = [
    {id: 'one', start_time: '2026-11-10T00:00:00Z', steps: 321},
    {id: 'two', start_time: '2026-11-12T00:00:00Z', steps: 123456},
  ];
  new HealthVault(path).write(key, {version: 1, enabled: true, owner: polarOwner, deletedBefore: 0, profileDeleted: false,
    connection: {clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture', userId: 1, expiresAt: now + 86400_000},
    observations: normalize('activity', activities, now)});
  const health = new HealthContext(path, {key: async () => Buffer.from(key), now: () => now,
    ownerAuthorized: () => true, ownerRevoked: () => false, sender, hosts: [], announce: bridge.sendMessage.bind(bridge)});
  t.after(() => {health.close(); history.close(); bridge.close(); rmSync(directory, {recursive: true, force: true});});
  await health.setup({action: 'status'});
  const invoke = (method: string, params?: unknown) => rpc(bridge, {jsonrpc: '2.0', id: 1, method, params},
    undefined, undefined, history, undefined, undefined, health) as Promise<any>;
  const call = (name: string, args: unknown) => invoke('tools/call', {name, arguments: args});
  return {invoke, call, control};
}

test('MCP discovery, selected historical fields, exclusive end, independent pages and legacy response guards', async t => {
  const f = await fixture(t);
  const tools = (await f.invoke('tools/list')).result.tools;
  const names = tools.map((tool: {name: string}) => tool.name);
  for (const name of ['get_factor_history', 'get_location_history', 'get_health_context', 'respond_to_context']) assert.ok(names.includes(name));
  const schema = tools.find((tool: {name: string}) => tool.name === 'get_factor_history').inputSchema;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required ?? [], []);
  for (const branch of ['oneOf', 'anyOf', 'allOf']) assert.ok(!(branch in schema));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.fields.properties.polar.items.enum.includes('steps'));
  assert.ok(schema.properties.source.enum.includes('polar'));
  assert.equal(schema.properties.cursor.format, 'uuid');
  const response = await f.call('get_factor_history', {...window, fields: selection, limit: 1});
  const page = response.result.structuredContent;
  assert.equal(page.version, 1);
  assert.deepEqual(page.window, window);
  assert.deepEqual(JSON.parse(response.result.content[0].text), page);
  assert.equal(page.sources.location.entries[0].measured_at, '2026-11-10T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(page.sources.location.entries), /12\.125|33\.125|latitude|longitude|geography/);
  assert.equal(page.sources.location.coverage.observation_count, 2);
  assert.equal(page.sources.polar.entries[0].fields.steps, 321);
  assert.doesNotMatch(JSON.stringify(page.sources.polar), /123456|accessToken/);
  const cursor = page.sources.location.next_cursor;
  const next = (await f.call('get_factor_history', {source: 'location', cursor})).result.structuredContent;
  assert.deepEqual(Object.keys(next.sources), ['location']);
  assert.equal(next.sources.location.entries[0].measured_at, '2026-11-10T12:00:00.000Z');
  assert.equal(next.sources.location.next_cursor, null);
  const refs = {...page.sources.location.response_context.arguments, ...page.sources.polar.response_context.arguments};
  const refused = await f.call('respond_to_context', {...refs, disposition: 'announce', text: 'Example'});
  assert.equal(refused.error.data.reason, 'history_question_required');
  assert.equal((await f.call('respond_to_context', {...refs, disposition: 'silent'})).result.structuredContent.stored_for_g2, false);
  f.control('delete');
  assert.ok((await f.call('respond_to_context', {...refs, disposition: 'silent'})).error);
  const partial = (await f.call('get_factor_history', {...window, fields: selection})).result.structuredContent.sources;
  assert.equal(partial.location.status, 'unavailable');
  assert.equal(partial.polar.entries[0].fields.steps, 321);
  const empty = (await f.call('get_factor_history', {start_at: '2026-11-08T00:00:00Z', end_at: '2026-11-08T00:01:00Z',
    fields: {polar: ['steps']}})).result.structuredContent.sources;
  assert.deepEqual(Object.keys(empty), ['polar']);
  assert.equal(empty.polar.status, 'empty');
});

test('different owners cannot return or use mixed receipts, while each authorized source remains independently readable', async t => {
  const f = await fixture(t, 'b'.repeat(64));
  const mixed = await f.call('get_factor_history', {...window, fields: selection});
  assert.equal(mixed.error.data.reason, 'history_access_changed');
  assert.doesNotMatch(JSON.stringify(mixed), /12\.125|321|aaaaaaa|bbbbbbb/);
  const location = (await f.call('get_factor_history', {...window, fields: {location: ['motion']}})).result.structuredContent.sources.location;
  const polar = (await f.call('get_factor_history', {...window, fields: {polar: ['steps']}})).result.structuredContent.sources.polar;
  assert.equal(location.status, 'available');
  assert.equal(polar.status, 'available');
  const denied = await f.call('respond_to_context', {...polar.response_context.arguments, ...location.response_context.arguments, disposition: 'silent'});
  assert.equal(denied.error.data.reason, 'context_access_changed');
});

test('strict requests reject undeclared fields, long or offset-free intervals and attempts to widen a continuation', async t => {
  const f = await fixture(t);
  for (const input of [{}, window, {source: 'polar'}, {cursor: randomUUID()}, {...window, fields: selection, cursor: randomUUID()},
    {...window, fields: {}}, {...window, fields: {polar: ['profile']}},
    {...window, fields: {location: ['motion', 'motion']}}, {...window, fields: selection, end_at: window.start_at},
    {...window, fields: selection, start_at: '2026-10-01T00:00:00Z'}, {...window, fields: selection, end_at: '2026-11-11T00:00:00'},
    {source: 'location', cursor: randomUUID(), fields: {location: ['geography']}}]) {
    assert.equal((await f.call('get_factor_history', input)).error.data.reason, 'invalid_arguments');
  }
});

test('a second adapter invalidating the first evidence prevents returning either result', () => {
  let allowed = true;
  const first: SelectedHistoryReader = {
    historyOwner: () => owner, responseGuard: () => () => allowed,
    readSelectedHistory: () => ({status: 'available', entries: [], next_cursor: null, response_context: {arguments: {history_context_ids: [randomUUID()]}}}),
  };
  const second: SelectedHistoryReader = {...first, readSelectedHistory() {
    allowed = false;
    return {status: 'empty', entries: [], next_cursor: null, response_context: {arguments: {health_read_ids: [randomUUID()]}}};
  }};
  assert.throws(() => readFactorHistory({...window, fields: selection}, {location: first, polar: second}, now), {reason: 'history_access_changed'});
});

test('a calendar window crossing now stops at the read time and a wholly future read is rejected', () => {
  const start_at = '2026-11-14T00:00:00Z', end_at = '2026-11-15T00:00:00Z', fields = {polar: ['steps']};
  const result = readFactorHistory({start_at, end_at, fields}, {}, now);
  assert.deepEqual(result.window, {start_at, end_at: new Date(now).toISOString()});
  assert.equal(result.requested_end_at, end_at);
  assert.throws(() => readFactorHistory({start_at: end_at, end_at: '2026-11-16T00:00:00Z', fields}, {}, now),
    {reason: 'invalid_arguments'});
});
