import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, {type TestContext} from 'node:test';
import { ArchiveAuthority } from '../server/history/archive-authority.ts';
import { openArchive, sealArchive } from '../server/history/archive-crypto.ts';
import { HistoryArchiveStore } from '../server/history/archive-store.ts';
import { weatherArchiveRecords } from '../server/history/environment-fields.ts';
import { EnvironmentHistory } from '../server/history/environment-history.ts';
import { weatherSource, type WeatherEvidence } from '../server/weather/types.ts';

const owner = 'c'.repeat(64);
const start = Date.UTC(2025, 0, 1, 9);
const hour = 3_600_000;
const day = 24 * hour;
const iso = (t: number) => new Date(t).toISOString();
const period = {start_at: iso(start + day), end_at: iso(start + day + hour), fields: ['temperature'], limit: 1};
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'environment-reader-'));
  const key = randomBytes(32);
  const keys = {async create() { return {key: Buffer.from(key), wrapped: 'synthetic-envelope'}; },
    async open() { return Buffer.from(key); }};
  let time = start;
  let authorized = true;
  const options = {now: () => time, ownerStatus: (id: string) => (id === owner && authorized ? 'authorized' : 'unavailable') as 'authorized' | 'unavailable'};
  const open = () => new ArchiveAuthority(directory, keys, options);
  let auth = open();
  let history = new EnvironmentHistory(auth, options.now);
  async function control(action: 'delete' | 'enable' | 'disable') {
    const {epoch} = await auth.status(owner);
    return auth.control(owner, epoch, action === 'delete' ? {action:'delete', source:'weather'} :
      {action:'set', source:'weather', enabled: action === 'enable'});
  }
  async function reopen() { auth.close(); auth = open(); await auth.restore(); history = new EnvironmentHistory(auth, options.now); }
  t.after(() => { auth.close(); key.fill(0); rmSync(directory, {recursive: true, force: true}); });
  return {directory, key, setTime(t: number) { time = t; }, authorize(enabled: boolean) { authorized = enabled; },
    get authority() { return auth; }, get history() { return history; }, get reader() { return history.reader('weather'); },
    control, reopen};
}
function forecast(available: number, temperature: number, limitations: string[] = []) {
  const evidence: WeatherEvidence = {status: 'ready', source: weatherSource, data_kind: 'model_forecast',
    query_point: {latitude: 10, longitude: 100}, as_of: iso(available), retrieved_at: iso(available), checked_at: iso(available),
    updated_at: iso(available), retry_at: null, elevation_m: null, current: null, apparent_temperature_c: null, limitations,
    forecast: [{valid_at: iso(start + day), temperature_c: temperature, humidity_percent: 40, pressure_hpa: null,
      cloud_percent: null, wind_m_s: null, wind_from_degrees: null, precipitation: []}]};
  const scope = {mode: 'specified', place: {latitude:10, longitude:100, label:'Fixture',source:'user_provided',reference:'synthetic'}} as const;
  const [record] = weatherArchiveRecords(evidence, scope, available);
  return record;
}

test('forecast versions retain cutoff, selected fields and location privacy across genuine source continuations', async t => {
  const f = fixture(t);
  assert.equal(f.history.capture(owner, 'weather'), undefined);
  assert.equal(f.reader.readSelectedHistory(period).status, 'unavailable');
  await f.control('enable');
  const write = f.history.capture(owner, 'weather')!;
  write(forecast(start, 20));
  f.setTime(start + hour);
  write(forecast(start + hour, 25));
  const earlier = f.reader.readSelectedHistory({...period, known_at: iso(start)});
  assert.equal(earlier.status, 'available');
  assert.equal(earlier.next_cursor, null);
  assert.equal(earlier.entries.length, 1);
  const first = earlier.entries[0] as {forecast: {temperature_c: number}[]; scope: string; place?: unknown};
  assert.deepEqual(first.forecast, [{valid_at: period.start_at, temperature_c: 20, apparent_temperature_c: null}]);
  assert.equal(first.scope, 'specified');
  assert.equal(first.place, undefined);
  const initial = f.reader.readSelectedHistory(period);
  assert.ok(initial.next_cursor);
  f.setTime(start + hour + 1);
  write(forecast(start + hour + 1, 30));
  assert.throws(() => f.history.reader('mobility').readSelectedHistory({cursor: initial.next_cursor!}));
  const next = f.reader.readSelectedHistory({cursor: initial.next_cursor});
  assert.equal(next.next_cursor, null);
  assert.match(JSON.stringify(next.entries), /"temperature_c":25/);
  assert.doesNotMatch(JSON.stringify(next.entries), /"temperature_c":30/);
  assert.throws(() => f.reader.readSelectedHistory({...period, known_at: iso(start + 2 * hour)}));
  f.setTime(start);
  assert.throws(() => f.reader.readSelectedHistory({cursor:initial.next_cursor!}));
});

test('empty and partial responses receive scoped receipts; stop, delete, owner changes and expiry fence response and capture', async t => {
  const f = fixture(t);
  await f.control('enable');
  const writer = f.history.capture(owner, 'weather')!;
  const empty = f.reader.readSelectedHistory(period);
  assert.equal(empty.status, 'empty');
  assert.ok('response_context' in empty);
  const emptyId = empty.response_context.arguments.archive_read_ids[0];
  assert.equal(f.history.responseContext(emptyId)?.owner, owner);
  assert.equal(f.history.reader('mobility').responseGuard(emptyId)(), false);
  writer(forecast(start, 22));
  const read = f.reader.readSelectedHistory(period);
  assert.ok('response_context' in read);
  const id = read.response_context.arguments.archive_read_ids[0];
  const guard = f.history.responseContext(id)!.guard;
  assert.ok(guard());
  await f.control('disable');
  assert.equal(guard(), false);
  assert.equal(f.history.responseContext(emptyId), undefined);
  f.setTime(start + hour);
  await f.control('enable');
  writer(forecast(start + hour, 88));
  assert.doesNotMatch(JSON.stringify(f.reader.readSelectedHistory(period)), /"temperature_c":88/);
  await f.control('delete');
  f.setTime(start + 2 * hour);
  await f.control('enable');
  const renewed = f.history.capture(owner, 'weather')!;
  assert.equal(renewed.since, start + 2 * hour);
  renewed(forecast(start, 37));
  assert.equal(f.reader.readSelectedHistory(period).status, 'empty');
  renewed(forecast(start + 2 * hour, 38));
  f.authorize(false);
  assert.equal(f.reader.historyOwner(), undefined);
  f.authorize(true);
  const expires = start + 2 * hour + 7 * day;
  f.setTime(expires - 100);
  const last = f.reader.readSelectedHistory(period);
  assert.ok('response_context' in last);
  assert.equal(last.response_context.expires_no_later_than, iso(expires));
  const lastId = last.response_context.arguments.archive_read_ids[0];
  const lastGuard = f.history.responseContext(lastId)!.guard;
  f.setTime(expires);
  assert.equal(lastGuard(), false);
  f.setTime(expires - 20);
  assert.equal(lastGuard(), false);
});

test('older grants gain a cutoff once at upgrade; earlier authorized records remain readable', async t => {
  const f = fixture(t);
  await f.control('enable');
  f.history.capture(owner, 'weather')!(forecast(start, 21));
  const legacy = new DatabaseSync(join(f.directory, 'authority.sqlite'));
  const row = legacy.prepare('SELECT sealed FROM authority WHERE id=1').get()!;
  const aad = 'dot-link:history:archive-authority:v1';
  const bytes = openArchive(f.key, aad, row.sealed as Uint8Array);
  const policy = JSON.parse(bytes.toString());
  bytes.fill(0);
  delete policy.sources.weather.since;
  legacy.prepare('UPDATE authority SET sealed=? WHERE id=1').run(sealArchive(f.key, aad, Buffer.from(JSON.stringify(policy))));
  legacy.close();
  f.setTime(start + hour);
  await f.reopen();
  assert.equal(f.history.capture(owner, 'weather')!.since, start + hour);
  assert.match(JSON.stringify(f.reader.readSelectedHistory(period).entries), /"temperature_c":21/);
  f.setTime(start + 2 * hour);
  await f.reopen();
  const writer = f.history.capture(owner, 'weather')!;
  assert.equal(writer.since, start + hour);
  writer(forecast(start + 100, 50));
  assert.doesNotMatch(JSON.stringify(f.reader.readSelectedHistory({...period, limit:10}).entries), /"temperature_c":50/);
});

test('one oversized record makes progress and pressure or an unknown schema is visible on a bounded page', async t => {
  const f = fixture(t);
  await f.control('enable');
  const write = f.history.capture(owner, 'weather')!;
  write(forecast(start, 20, ['synthetic'.repeat(8000)]));
  const lower = forecast(start, 22);
  write(lower);
  write({...lower, id:'retired-field-shape', version: 400, payload: {new_only: true}});
  write({...lower, id:'over-capacity', payload: 'x'.repeat(300 * 1024)});
  const first = f.reader.readSelectedHistory({...period,limit:10});
  assert.equal(first.status, 'partial');
  assert.ok('coverage' in first);
  assert.equal(first.coverage.capacity_omitted, true);
  assert.ok(first.coverage.reduced_records);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 48 * 1024);
  assert.ok(first.next_cursor);
  const next = f.reader.readSelectedHistory({cursor: first.next_cursor});
  assert.ok('coverage' in next);
  assert.equal(next.coverage.unsupported_version_records, 1);
  assert.match(JSON.stringify(next.entries), /"temperature_c":22/);
  assert.equal(next.next_cursor, null);
});

test('record budget is fixed in a continuation and a single large row remains readable', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reader-budget-'));
  const store = new HistoryArchiveStore(join(dir, 'records.sqlite'), randomBytes(32), {now:() => start});
  t.after(() => { store.close(); rmSync(dir, {recursive:true, force:true}); });
  store.put(forecast(start, 20), '7d');
  store.put(forecast(start, 25), '7d');
  const q = {fromMs: start + day, toMs: start + day + hour, limit:10, maxBytes: 1};
  const page = store.read(q);
  assert.equal(page.records.length,1);
  assert.ok(page.nextCursor);
  assert.throws(() => store.read({...q, maxBytes:2, cursor:page.nextCursor!}));
  const next = store.read({...q, cursor:page.nextCursor});
  assert.equal(next.records.length,1);
  assert.equal(next.nextCursor,null);
});
