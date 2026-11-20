import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {LocationHistoryStore} from '../server/history/store.ts';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installPhoneTimeIndex, phoneTimeEvidence, readStoredPhoneTime} from '../server/history/phone-time.ts';
import {HISTORY_RETENTION_MS, type HistoryEntry} from '../server/history/replay.ts';

function open() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE observations (id TEXT PRIMARY KEY, measured INTEGER NOT NULL, data TEXT NOT NULL, geography TEXT, expires_at INTEGER);');
  return db;
}

test('stored phone time matches the dated projection with delayed, overlapping, absent and offset-form receipts', t => {
  const db = open();
  t.after(() => db.close());
  const rows: HistoryEntry[] = [];
  const insert = db.prepare('INSERT INTO observations(id, measured, data, expires_at) VALUES(?,?,?,?)');
  const anchor = Date.parse('2026-11-07T12:00:00Z');
  function add(id: string, received_at: string | undefined, offset: number | undefined = 60, expiry = anchor + HISTORY_RETENTION_MS) {
    const measured = anchor + rows.length;
    const row: HistoryEntry = {id, source: 'phone_location', latitude: 5, longitude: 4, accuracy: 2, measured_at: new Date(measured).toISOString(),
      received_at, recording_epoch: rows.length % 3, timezone: 'Etc/UTC', utc_offset_minutes: offset, expires_at: expiry};
    if (id === 'missing-clock') delete row.utc_offset_minutes;
    const {expires_at, ...data} = row;
    insert.run(id, measured, JSON.stringify(data), expires_at);
    rows.push({...row, expires_at: Math.min(expires_at, measured + HISTORY_RETENTION_MS)});
  }
  // The index must also pick up older writers' named-column inserts after installation.
  add('legacy-no-receipt', undefined);
  add('before', '2026-11-08T10:59:59.9999+01:00');
  installPhoneTimeIndex(db);
  installPhoneTimeIndex(db);
  add('inclusive-start', '2026-11-08T11:00:00.000+01:00');
  add('late', '2026-11-10T01:20:00+15:59');
  add('ties', '2026-11-09T09:21:00Z');
  add('missing-clock', '2026-11-09T09:21:00.000Z');
  add('shortest-grant', '2026-11-09T23:00:00Z', 30, anchor + 90_000);
  add('near-end', '2026-11-11T13:59:59.999999Z');
  add('exclusive-end', '2026-11-11T13:30:00-00:30');
  add('separate', '2026-11-20T22:00:00.250-03:30', -210, anchor + 2 * HISTORY_RETENTION_MS);
  const days = ['2026-11-10','2026-11-20','2026-11-09','2026-11-09'];
  const actual = readStoredPhoneTime(db, days);
  assert.deepEqual(actual, phoneTimeEvidence(rows, days));
  assert.ok('by_source_date' in actual.evidence);
  assert.equal(actual.earliestExpiry, anchor + 90_000);
  assert.deepEqual(actual.evidence.by_source_date.map(d => d.observation_count), [5, 2, 1]);
  assert.equal(actual.evidence.by_source_date[0].reference.status, 'ambiguous');
  assert.equal(actual.evidence.by_source_date[1].spans.at(-1)?.last.received_at, '2026-11-11T13:59:59.999999Z');
  assert.deepEqual(readStoredPhoneTime(db, ['2026-11-20']), phoneTimeEvidence(rows, ['2026-11-20']));
  assert.deepEqual(readStoredPhoneTime(db, []), phoneTimeEvidence([], []));
});

test('invalid request dates preserve the store while corrupted selected clock evidence fails closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-clock-input-'));
  const owner = 'a'.repeat(64), now = Date.parse('2026-11-09T12:00:00Z');
  const store = new LocationHistoryStore(dir, {now: () => now, ownerAuthorized: () => true, announce: async () => {}});
  t.after(() => { store.close(); rmSync(dir, {recursive:true, force:true}); });
  store.control({protocol: 1, epoch: store.status(owner).historyEpoch, action: 'enable'}, owner);
  for (const dates of [['2026-02-29'], ['invalid'], Array(81).fill('2026-11-09')]) {
    assert.equal(store.readPhoneTime(dates,owner).evidence.status, 'unavailable');
    assert.equal(store.status(owner).historyEnabled, true);
    assert.equal(store.readPhoneTime(['2026-11-09'], owner).evidence.status, 'empty');
  }
  const measured_at = new Date(now).toISOString();
  const db = new DatabaseSync(join(dir, 'history.sqlite'));
  try {
    const data = {id:'broken-clock', source:'phone_location', measured_at, received_at:measured_at,
      recording_epoch:1, timezone:'unexpected clock label', utc_offset_minutes:0};
    db.prepare('INSERT INTO observations(id, measured, data, expires_at) VALUES(?,?,?,?)')
      .run(data.id, now, JSON.stringify(data), now + HISTORY_RETENTION_MS);
  } finally { db.close(); }
  assert.equal(store.readPhoneTime([measured_at.slice(0,10)], owner).evidence.status, 'unavailable');
  assert.equal(store.status(owner).historyProtocol, 0);
});

test('the actual clock query uses a receipt index range at 50,000 rows and excludes out-of-window payloads', t => {
  const db = open(); t.after(() => db.close()); installPhoneTimeIndex(db);
  const insert = db.prepare('INSERT INTO observations(id,measured,data,expires_at) VALUES(?,?,?,?)');
  const midnight = Date.parse('2026-11-09T00:00:00Z');
  const days = ['2026-11-09','2026-11-10'];
  const planSpy = t.mock.method(db, 'prepare');
  db.exec('BEGIN');
  for (let i=0; i<50_000; i++) {
    const measured = midnight - 3 * 86_400_000 + i * 10, id = String(i);
    const measured_at = new Date(measured).toISOString();
    const data = {id, source: 'phone_location', measured_at, received_at: i === 49_999 ? new Date(midnight).toISOString() : measured_at,
      recording_epoch: 1, timezone: 'Etc/UTC', utc_offset_minutes: 0};
    insert.run(id, measured, JSON.stringify(data), measured + HISTORY_RETENTION_MS);
  }
  db.exec('COMMIT');
  const result = readStoredPhoneTime(db, days);
  assert.ok('by_source_date' in result.evidence);
  assert.deepEqual(result.evidence.by_source_date.map(d => d.observation_count), [1, 0]);
  const [call] = planSpy.mock.calls;
  assert.equal(planSpy.mock.callCount(), 1);
  planSpy.mock.restore();
  const sql = call.arguments[0];
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(midnight / 1000, midnight / 1000 + 3600);
  assert.ok(plan.some(x => String(x.detail).includes('SEARCH observations USING INDEX observation_receipt_minute')));
  assert.ok(plan.every(x => !String(x.detail).includes('SCAN observations')));
  assert.doesNotMatch(sql, /latitude|longitude|geography/);
});
