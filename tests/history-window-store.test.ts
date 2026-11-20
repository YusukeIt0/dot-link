import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocationHistoryIndex } from '../server/history/replay.ts';
import { LocationHistoryStore } from '../server/history/store.ts';

const owner = 'a'.repeat(64);
const start = Date.parse('2026-01-01T00:00:00Z');
const minute = 60_000;
const day = 24 * 60 * minute;
const iso = (ms: number) => new Date(ms).toISOString();

function setup(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'history-window-'));
  let now = start;
  const open = () => new LocationHistoryStore(directory, {
    now: () => now, ownerAuthorized: candidate => candidate === owner, announce: async () => {},
  });
  let store = open();
  t.after(() => { store.close(); rmSync(directory, {recursive: true, force: true}); });
  const control = (action: 'enable' | 'disable') =>
    store.control({protocol: 1, epoch: store.status(owner).historyEpoch, action}, owner);
  control('enable');
  return {
    get store() { return store; }, path: join(directory, 'history.sqlite'), now: () => now,
    at(ms: number) { now = ms; }, reopen() { store.close(); store = open(); }, control,
  };
}

test('durable windows project the same summaries, gaps and successive detail pages as replay', t => {
  const h = setup(t);
  const replay = new LocationHistoryIndex({source: 'phone_location', now: h.now});
  replay.setReadable(true);
  replay.setRecording(true);
  const epoch = h.store.status(owner).historyEpoch;
  const upload = {protocol: 1, epoch, timezone: 'Etc/UTC', utc_offset_minutes: 0};
  for (const [index, measuredMinute] of [0, 1, 3, 2, 4, 5, 6, 14, 15].entries()) {
    h.at(start + (index + 20) * minute);
    const measured = iso(start + measuredMinute * minute);
    const fix = {measured_at: measured, latitude: 10, longitude: measuredMinute < 4 ? 10 : 10 + measuredMinute / 1000, accuracy: 6};
    if (measuredMinute === 14) { replay.setRecording(false); replay.setRecording(true); }
    const session = measuredMinute < 14 ? 'first' : 'second';
    assert.equal(h.store.ingest(fix, session, upload, owner), true);
    const id = createHash('sha256').update(`${owner}:${measured}`).digest('hex');
    assert.equal(replay.observe({...fix, id, source: 'phone_location', received_at: iso(h.now()),
      timezone: upload.timezone, utc_offset_minutes: upload.utc_offset_minutes}).accepted, true);
    assert.equal(h.store.ingest(fix, session, upload, owner), false);
  }
  h.reopen();
  for (const detail of ['summary', 'observations'] as const) {
    for (const [from, until] of [[0, 16], [1, 5], [8, 14]]) {
      const query = {start_at: iso(start + from * minute), end_at: iso(start + until * minute), detail, limit: 1};
      let expected = replay.read(query);
      let actual = h.store.read(query);
      for (;;) {
        assert.ok('coverage' in actual && 'coverage' in expected);
        assert.deepEqual(actual.query, expected.query);
        assert.equal(actual.status, expected.status);
        assert.deepEqual(actual.coverage, expected.coverage);
        assert.deepEqual(actual.entries, expected.entries);
        assert.equal(Boolean(actual.next_cursor), Boolean(expected.next_cursor));
        if (!actual.next_cursor || !expected.next_cursor) break;
        actual = h.store.read({cursor: actual.next_cursor});
        expected = replay.read({cursor: expected.next_cursor});
      }
    }
  }
});

test('reopen, consent, expiry, and narrow reads leave unrelated v1 payloads unparsed', t => {
  const h = setup(t);
  h.store.close();
  const oldWriter = new DatabaseSync(h.path);
  const marker = 'outside-window-fixture';
  try {
    const insert = oldWriter.prepare('INSERT INTO observations(id,measured,data,geography) VALUES(?,?,?,?)');
    // A previous writer can omit the added expiry/time index columns. Different
    // stored IDs may share a measured instant; public pages must have a stable tie-break.
    for (const [id, measured] of [
      ['expires-today', start], [marker, start + 2 * day], ['tie-Z', start + 6 * day], ['tie-a', start + 6 * day],
    ] as const) {
      const row = {id, source: 'phone_location', latitude: 10, longitude: 10, accuracy: 5,
        measured_at: iso(measured), received_at: iso(measured + 1_000), timezone: 'Etc/UTC',
        utc_offset_minutes: 0, recording_epoch: 0};
      const geography = {source: id === marker ? marker : 'fixture', release: 'v1', attribution: 'fixture',
        license_url: 'https://example.test/license', areas: [], lines: [], landmarks: [], limitations: []};
      insert.run(id, measured, JSON.stringify(row), JSON.stringify(geography));
    }
  } finally { oldWriter.close(); }
  const parse = JSON.parse;
  let unrelatedDecodes = 0;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof parse>) => {
    if (args[0].includes(marker)) unrelatedDecodes++;
    return parse(...args);
  });
  h.at(start + 7 * day - 1);
  h.reopen();
  assert.equal(h.store.status(owner).historyCount, 4);
  h.control('disable');
  assert.equal(h.store.read().status, 'unavailable');
  h.control('enable');
  h.at(start + 7 * day);
  assert.equal(h.store.status(owner).historyCount, 3);
  const query = {start_at: iso(start + 6 * day), end_at: iso(start + 6 * day + 1), detail: 'observations', limit: 1};
  const first = h.store.read(query);
  assert.ok(first.next_cursor);
  const second = h.store.read({cursor: first.next_cursor});
  assert.equal(second.next_cursor, null);
  assert.deepEqual([...first.entries, ...second.entries].map(entry => entry.id), ['tie-a', 'tie-Z']);
  assert.equal(h.store.readPhoneTime(['2026-01-07'], owner).evidence.status, 'available');
  assert.equal(unrelatedDecodes, 0);
});

function readingAtDeadline(t: test.TestContext) {
  const h = setup(t);
  const measured = start + 12_345, measuredAt = iso(measured), deadline = measured + 7 * day;
  h.at(measured);
  assert.equal(h.store.ingest({latitude: 10, longitude: 10, accuracy: 5, measured_at: measuredAt},
    'session', {protocol: 1, epoch: h.store.status(owner).historyEpoch, timezone: 'Etc/UTC', utc_offset_minutes: 0}, owner), true);
  h.at(deadline - 1);
  return {
    store: h.store, crossDeadlineOnDecode() {
      // Advance the injected store clock exactly as the selected row's source
      // timestamp is decoded, after maintenance has admitted it to this read.
      const parse = Date.parse;
      t.mock.method(Date, 'parse', (value: string) => {
        if (value === measuredAt) h.at(deadline);
        return parse(value);
      });
    },
    assertDeadlineReached() { assert.equal(h.now(), deadline); },
  };
}

test('a location fix expiring during projection is withheld from the initial tool result', t => {
  const h = readingAtDeadline(t);
  assert.equal(h.store.read({detail: 'observations'}).status, 'available');
  h.crossDeadlineOnDecode();
  assert.throws(() => h.store.read({detail: 'observations'}), {name: 'ToolRejection', reason: 'history_access_changed'});
  h.assertDeadlineReached();
});

test('a phone clock expiring during projection returns neither evidence nor a read guard', t => {
  const h = readingAtDeadline(t);
  assert.equal(h.store.readPhoneTime(['2026-01-01'], owner).evidence.status, 'available');
  h.crossDeadlineOnDecode();
  assert.deepEqual(h.store.readPhoneTime(['2026-01-01'], owner), {evidence: {status: 'unavailable'}});
  h.assertDeadlineReached();
});

test('at the production cap an eviction invalidates its time window and preserves an unrelated page', t => {
  const h = setup(t);
  const maximum = 50_000;
  h.store.close();
  const db = new DatabaseSync(h.path);
  try {
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO observations(id,measured,data) VALUES(?,?,?)');
    for (let i = 0; i < maximum; i++) {
      const id = `fix-${i}`, measured = start + i * 1_000;
      insert.run(id, measured, JSON.stringify({id, source: 'phone_location', measured_at: iso(measured),
        latitude: 10, longitude: 10, accuracy: 5, recording_epoch: 0}));
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  h.at(start + day);
  h.reopen();
  const window = (offsetSeconds: number) => h.store.read({start_at: iso(start + offsetSeconds * 1_000),
    end_at: iso(start + (offsetSeconds + 2) * 1_000), detail: 'observations', limit: 1});
  const oldest = window(0), unaffected = window(maximum - 2);
  assert.ok(oldest.next_cursor && unaffected.next_cursor);
  assert.equal(h.store.ingest({latitude: 10, longitude: 10, accuracy: 5, measured_at: iso(h.now())},
    'session', {protocol: 1, epoch: h.store.status(owner).historyEpoch}, owner), true);
  assert.throws(() => h.store.read({cursor: oldest.next_cursor}), /page is no longer available/);
  const next = h.store.read({cursor: unaffected.next_cursor});
  assert.deepEqual(next.entries.map(entry => entry.id), [`fix-${maximum - 1}`]);
  assert.ok('coverage' in next);
  assert.equal(next.coverage.capacity_omissions, true);
  assert.equal(h.store.status(owner).historyCount, maximum);
  assert.deepEqual(window(0).entries.map(entry => entry.id), ['fix-1']);
});
