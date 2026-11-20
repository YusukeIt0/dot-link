import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { HistoryArchiveStore, type ArchiveInput } from '../server/history/archive-store.ts';

const DAY = 86_400_000;
const start = Date.UTC(2024, 0, 31, 12);
function fixture(t: TestContext, options: { maxRecords?: number; maxBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'encrypted-history-'));
  const path = join(dir, 'store.sqlite');
  const key = randomBytes(32);
  let now = start;
  const open = () => new HistoryArchiveStore(path, key, {now: () => now, ...options});
  let store = open();
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return {dir, path, key, get store() { return store; }, setNow(at: number) { now = at; },
    reopen() { store.close(); store = open(); }};
}
function record(id: string, fromMs = start, toMs = fromMs + 1): ArchiveInput {
  return {id, version: 1, fromMs, toMs, anchorMs: start, availableAtMs: start, payload: {source: 'synthetic', id}};
}

test('assigned deadlines outlive policy changes and restarts; an expired record cannot be admitted under a later policy', t => {
  const f = fixture(t);
  const jan = record('end-of-month');
  assert.equal(f.store.put(jan, '1m'), 'stored');
  assert.equal(f.store.put(record('seven'), '7d'), 'stored');
  assert.equal(f.store.put(record('year'), '1y'), 'stored');
  f.reopen();
  assert.equal(f.store.put(jan, '1y'), 'duplicate');
  assert.equal(f.store.put(record('year'), '7d'), 'duplicate');
  const query = {fromMs: start, toMs: start + 1};
  const end = Date.UTC(2024, 1, 29, 12);
  assert.equal(f.store.read(query).records.find(r => r.id === jan.id)?.expiresAtMs, end);
  f.setNow(start + 7 * DAY);
  assert.deepEqual(f.store.read(query).records.map(r => r.id), [jan.id, 'year']);
  assert.equal(f.store.prune(), 1);
  f.reopen();
  assert.equal(f.store.put(record('seven'), '1y'), 'expired');
  assert.equal(f.store.put(record('first-received-late'), '7d'), 'expired');
  f.setNow(end);
  assert.deepEqual(f.store.read(query).records.map(r => r.id), ['year']);
  assert.equal(f.store.prune(), 1);
  f.setNow(Date.UTC(2025, 0, 31, 12));
  assert.deepEqual(f.store.read(query).records, []);
  assert.equal(f.store.prune(), 3);
  assert.equal(f.store.put(jan, '1y'), 'expired');
});

test('preserves interval, source version and knowledge time; a spanning record occurs once across bounded pages', t => {
  const f = fixture(t);
  const early = record('forecast-first-issue', start + DAY, start + 4 * DAY);
  early.payload = {kind: 'forecast', weather: 20};
  assert.equal(f.store.put(early, '6m'), 'stored');
  f.setNow(start + DAY);
  const revision = {...early, id: 'forecast-revision', version: 2, availableAtMs: start + DAY, anchorMs: start + DAY,
    payload: {kind: 'forecast', weather: 28, added_optional_field: true}};
  assert.equal(f.store.put(revision, '6m'), 'stored');
  assert.equal(f.store.put(record('outside', start + 5 * DAY), '6m'), 'stored');
  const window = {fromMs: start + 2 * DAY, toMs: start + 4 * DAY, limit: 1};
  assert.deepEqual(f.store.read({...window, knownAtMs: start}).records.map(r => r.id), [early.id]);
  assert.deepEqual(f.store.read({fromMs: start + 4 * DAY, toMs: start + 5 * DAY}).records, []);
  const first = f.store.read(window);
  assert.deepEqual(first.records.map(r => r.id), [early.id]);
  assert.ok(first.nextCursor);
  assert.equal(f.store.put({...early, id: 'after-first-page'}, '1y'), 'stored');
  const second = f.store.read({...window, cursor: first.nextCursor});
  assert.deepEqual(second.records.map(r => [r.id, r.version, r.payload]), [[revision.id, 2, revision.payload]]);
  assert.equal(second.nextCursor, null);
  assert.throws(() => f.store.read({...window, knownAtMs: start, cursor: first.nextCursor!}));
  assert.throws(() => f.store.read({...window, limit: 2, cursor: first.nextCursor!}));
  assert.throws(() => f.store.read({...window, cursor: first.nextCursor!.slice(4)}));
  f.store.clear();
  f.store.put(revision, '7d');
  assert.throws(() => f.store.read({...window, cursor: first.nextCursor!}));
  f.store.clear();
  assert.deepEqual(f.store.read(window).records, []);
});

test('independent handles preserve the first policy and durable omission together', t => {
  const f = fixture(t, {maxRecords: 2});
  const second = new HistoryArchiveStore(f.path, f.key, {now: () => start, maxRecords: 2});
  try {
    assert.equal(f.store.put(record('first'), '7d'), 'stored');
    assert.equal(second.put(record('first'), '1y'), 'duplicate');
    assert.equal(second.put(record('second'), '1y'), 'stored');
    assert.equal(f.store.put(record('third'), '6m'), 'capacity');
    const page = second.read({fromMs: start, toMs: start + DAY});
    assert.deepEqual(page.records.map(r => r.period), ['7d', '1y']);
    assert.ok(page.capacityOmitted);
  } finally { second.close(); }
});

test('capacity loss is durable, and filtered-out rows are bounded even in a dense UTC day', t => {
  const f = fixture(t, {maxRecords: 170});
  for (let i = 0; i < 170; i++) assert.equal(f.store.put(record(String(i), start + i), '7d'), 'stored');
  assert.equal(f.store.put(record('omitted'), '7d'), 'capacity');
  f.reopen();
  const window = {fromMs: start + 160, toMs: start + 162, limit: 10};
  const first = f.store.read(window);
  assert.deepEqual(first.records, []);
  assert.ok(first.nextCursor);
  assert.equal(first.capacityOmitted, true);
  const second = f.store.read({...window, cursor: first.nextCursor});
  assert.deepEqual(second.records.map(r => r.id), ['160', '161']);
  assert.equal(second.nextCursor, null);
  f.store.clear();
  assert.equal(f.store.read(window).capacityOmitted, false);
});

test('one-hour reads skip other dense hours while including multi-hour spans', t => {
  const f = fixture(t);
  const hour = 3_600_000;
  for (let i = 0; i < 160; i++) f.store.put(record('elsewhere-' + i, start + i), '7d');
  f.store.put(record('spans', start - hour, start + 3 * hour), '1m');
  f.store.put(record('later-point', start + 2 * hour), '1m');
  const page = f.store.read({fromMs: start + 2 * hour, toMs: start + 3 * hour});
  assert.deepEqual(page.records.map(r => r.id), ['spans', 'later-point']);
  assert.equal(page.nextCursor, null);
});

test('bounded maintenance visits every expired row even with future records in the same due bucket', t => {
  const f = fixture(t);
  const late = {...record('later'), anchorMs: start + 50, availableAtMs: start + 50};
  f.setNow(start + 50);
  assert.equal(f.store.put(late, '7d'), 'stored');
  for (let i = 0; i < 9; i++) f.store.put(record('early-' + i), '7d');
  f.setNow(start + 7 * DAY);
  let removed = 0;
  for (let i = 0; i < 6; i++) removed += f.store.prune(2);
  assert.equal(removed, 9);
  assert.deepEqual(f.store.read({fromMs: start, toMs: start + DAY}).records.map(r => r.id), ['later']);
  f.setNow(start + 7 * DAY + 50);
  assert.equal(f.store.prune(2), 1);
});

test('on-disk records, lookup fields and cursors contain no plaintext identifiers or source timestamps; wrong-generation restore fails closed', t => {
  const f = fixture(t);
  const id = 'fictional-private-place-127';
  const r = {...record(id), payload: {private_label_127: 'fictional-private-value'}};
  f.store.put(r, '1y');
  f.store.put({...r, id: 'second'}, '1y');
  const query = {fromMs: start, toMs: start + 1, limit: 1};
  const page = f.store.read(query);
  const disk = readFileSync(f.path);
  const cursor = Buffer.from(page.nextCursor!, 'base64url');
  for (const raw of [id, 'private_label_127', 'fictional-private-value', String(start)]) {
    assert.equal(disk.includes(raw), false);
    assert.equal(cursor.includes(raw), false);
  }
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const copy = join(f.dir, 'replayed.sqlite');
  assert.throws(() => new HistoryArchiveStore(copy, f.key, {existingOnly: true}));
  writeFileSync(copy, Buffer.alloc(0), {mode: 0o600});
  assert.throws(() => new HistoryArchiveStore(copy, f.key, {existingOnly: true}));
  const blank = new DatabaseSync(copy);
  blank.exec('VACUUM');
  blank.close();
  assert.ok(statSync(copy).size > 0);
  assert.throws(() => new HistoryArchiveStore(copy, f.key, {existingOnly: true}));
  copyFileSync(f.path, copy);
  assert.throws(() => new HistoryArchiveStore(copy, randomBytes(32)));
  const sql = new DatabaseSync(f.path);
  const first = sql.prepare('SELECT body FROM entries WHERE n=1').get()!.body;
  sql.prepare('UPDATE entries SET body=? WHERE n=2').run(first);
  sql.close();
  assert.throws(() => f.store.read(query));
});
