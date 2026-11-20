import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocationHistoryStore } from '../server/history/store.ts';
import type { GeographicEvidence } from '../server/geography/types.ts';

const owner = 'f'.repeat(64);
const begin = Date.parse('2026-03-01T12:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const unavailable = {status: 'unavailable', entries: [], next_cursor: null};

function setup(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'history-location-fields-'));
  let now = begin, authorized = true;
  const store = new LocationHistoryStore(directory, {now: () => now, ownerAuthorized: id => id === owner && authorized,
    announce: async () => {}});
  t.after(() => { store.close(); rmSync(directory, {recursive: true, force: true}); });
  const control = (action: 'enable' | 'disable' | 'delete') =>
    store.control({protocol: 1, epoch: store.status(owner).historyEpoch, action}, owner);
  return {store, control, authorize(value: boolean) { authorized = value; },
    add(index: number, geography?: GeographicEvidence) {
      now = begin + index * 1000;
      const fix = {measured_at: iso(now), latitude: 10, longitude: 20, accuracy: 5,
        ...(index === 0 ? {speed: 0, heading: 0} : {})};
      assert.equal(store.ingest(fix, index < 2 ? 'first' : 'second',
        {protocol: 1, epoch: store.status(owner).historyEpoch, ...(index === 0 ? {timezone: 'Etc/UTC', utc_offset_minutes: 0} : {})}, owner), true);
      if (geography) store.attachGeography(fix, geography, owner);
    }};
}

test('selected history preserves source, exact bounds, gaps and only the requested fields on every page', t => {
  const h = setup(t);
  const window = {start_at: iso(begin), end_at: iso(begin + 3000), limit: 1};
  assert.equal(h.store.historyOwner(), undefined);
  assert.deepEqual(h.store.readSelectedHistory({...window, fields: ['motion']}), unavailable);
  h.control('enable');
  assert.equal(h.store.historyOwner(), owner);
  for (let i = 0; i < 4; i++) h.add(i);
  const first = h.store.readSelectedHistory({...window, fields: ['motion']});
  assert.ok(first.next_cursor && 'coverage' in first && 'response_context' in first);
  assert.equal(first.coverage.observation_count, 3);
  assert.equal(first.coverage.gaps[0].reason, 'recording_boundary');
  assert.deepEqual(first.entries[0], {id: first.entries[0].id, source: 'phone_location', measured_at: iso(begin), speed: 0, heading: 0});
  assert.deepEqual(first.response_context.arguments.history_context_ids, [first.history_context_id]);
  assert.deepEqual(Object.keys(first.field_definitions!), ['motion']);
  assert.match(first.field_definitions!.motion, /metres per second/);
  assert.throws(() => h.store.read({cursor: first.next_cursor}), {reason: 'history_cursor_expired'});
  assert.throws(() => h.store.readSelectedHistory({cursor: first.next_cursor!, fields: ['position']} as never), {reason: 'invalid_arguments'});
  const second = h.store.readSelectedHistory({cursor: first.next_cursor});
  assert.deepEqual(second.entries[0], {id: second.entries[0].id, source: 'phone_location', measured_at: iso(begin + 1000), speed: null, heading: null});
  assert.ok(second.next_cursor);
  const last = h.store.readSelectedHistory({cursor: second.next_cursor});
  assert.equal(last.next_cursor, null);
  assert.ok('measured_at' in last.entries[0]);
  assert.equal(last.entries[0].measured_at, iso(begin + 2000));
  const legacy = h.store.read({...window, detail: 'observations'});
  assert.ok(legacy.next_cursor);
  assert.throws(() => h.store.readSelectedHistory({cursor: legacy.next_cursor!}), {reason: 'history_cursor_expired'});
  const read = h.store.readSelectedHistory({...window, fields: ['clock', 'position'], limit: 3});
  assert.deepEqual(read.entries[0], {id: first.entries[0].id, source: 'phone_location', measured_at: iso(begin), received_at: iso(begin),
    latitude: 10, longitude: 20, accuracy: 5, timezone: 'Etc/UTC', utc_offset_minutes: 0});
  assert.deepEqual(read.entries[1], {id: second.entries[0].id, source: 'phone_location', measured_at: iso(begin + 1000),
    latitude: 10, longitude: 20, accuracy: 5, received_at: iso(begin + 1000), timezone: null, utc_offset_minutes: null});
  for (const fields of [[], ['not_a_field'], ['clock', 'clock']]) {
    assert.throws(() => h.store.readSelectedHistory({...window, fields}), {reason: 'invalid_arguments'});
  }
  h.authorize(false);
  assert.equal(h.store.historyOwner(), undefined);
  assert.throws(h.store.responseGuard(first.history_context_id));
  h.authorize(true); h.control('delete'); h.control('enable');
  assert.throws(() => h.store.readSelectedHistory({cursor: first.next_cursor!}), {reason: 'history_cursor_expired'});
  assert.equal(h.store.readSelectedHistory({...window, fields: ['motion']}).status, 'empty');
});

test('large geography is fetched only when selected and consumes only its own page budget', t => {
  const h = setup(t); h.control('enable');
  const refs = [0, 1].map(i => ({id: String(i) + 'r'.repeat(98), name: 'n'.repeat(100), kind: 'l'.repeat(50), relation: 'near' as const, distance_m: 25}));
  const map: GeographicEvidence = {source: 'fixture map', release: 'v1', attribution: 'a'.repeat(249), license_url: 'https://example.test/license',
    limitations: ['s'.repeat(149), 'g'.repeat(149)], areas: refs, lines: refs, landmarks: refs};
  for (let i = 0; i < 50; i++) h.add(i, map);
  const window = {start_at: iso(begin), end_at: iso(begin + 50_000), limit: 50};
  let mapDecodes = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (value: string) => {
    if (value.includes('fixture map')) mapDecodes++;
    return parse(value);
  });
  const clocks = h.store.readSelectedHistory({...window, fields: ['clock']});
  assert.equal(clocks.entries.length, 50);
  assert.equal(clocks.next_cursor, null);
  assert.equal('geography' in clocks.entries[0], false);
  assert.equal(mapDecodes, 0);
  const maps = h.store.readSelectedHistory({...window, fields: ['geography']});
  assert.ok(maps.next_cursor && maps.entries.length < 50);
  assert.ok(mapDecodes >= maps.entries.length);
  const entry = maps.entries[0];
  assert.ok('geography' in entry && entry.geography?.status === 'available');
  assert.equal(entry.geography.source, 'fixture map');
  assert.equal(entry.geography.lines.length, 2);
  assert.equal('latitude' in entry, false);
  assert.equal('received_at' in entry, false);
});
