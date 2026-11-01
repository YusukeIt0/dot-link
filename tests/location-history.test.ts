import test from 'node:test';
import assert from 'node:assert/strict';
import { LocationHistoryReplay, HISTORY_RETENTION_MS, HISTORY_PAGE_BYTES, HISTORY_REPLAY_LIMIT } from '../server/history/replay.ts';
import { locationHistoryTool } from '../server/history/tool.ts';
import { historyFixture, historyGeography } from './fixtures/location-history.ts';
import { geographicEvidence } from '../server/geography/geometry.ts';
import { ToolRejection } from '../server/tool-response.ts';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const fix = (id: string, time: number, latitude = 10, longitude = 10, accuracy = 8) => ({ id, source: 'synthetic_fixture',
  measured_at: new Date(time).toISOString(), latitude, longitude, accuracy });
const read = (h: LocationHistoryReplay, args?: unknown): any => h.read(args);
function owner() {
  let clock = NOW;
  const history = new LocationHistoryReplay({ now: () => clock });
  history.setReadable(true); history.setRecording(true);
  return { history, advance: (ms: number) => { clock += ms; } };
}
function pages(h: LocationHistoryReplay, args: unknown) {
  let page = read(h, args); const result = [...page.entries]; let count = 1;
  while (page.next_cursor) {
    assert.ok(count++ < 1000, 'pagination must make progress');
    page = read(h, { cursor: page.next_cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= HISTORY_PAGE_BYTES);
    result.push(...page.entries);
  }
  return result;
}

test('preview does not record or disclose without independent controls', () => {
  const history = new LocationHistoryReplay({ now: () => NOW });
  assert.deepEqual(history.observe(fix('a', NOW - 60_000)), { accepted: false, reason: 'recording_stopped' });
  assert.equal(read(history).status, 'unavailable');
  history.setRecording(true);
  assert.equal(history.observe(fix('a', NOW - 60_000)).accepted, true);
  assert.deepEqual(read(history).entries, []);
  history.setReadable(true);
  assert.equal(read(history).entries.length, 1);
  history.setRecording(false);
  assert.equal(read(history).entries.length, 1, 'recording stop does not revoke separately allowed reads');
  history.setReadable(false);
  assert.deepEqual(read(history).entries, []);
});

test('turns and revisits pass through observation ingestion and existing geographic relations', () => {
  const { history } = historyFixture('walk', NOW);
  const summary = read(history);
  const stays = summary.entries.filter((s: any) => s.kind === 'candidate_stay');
  assert.equal(stays.length, 4);
  assert.deepEqual(stays[1].first_position, stays[3].first_position);
  assert.notEqual(stays[1].id, stays[3].id, 'return visits remain separate');
  const movement = summary.entries.find((s: any) => s.kind === 'movement_observations');
  assert.ok(movement);
  assert.equal(movement.observation_count, 14);
  const route = pages(history, { start_at: movement.observed_start_at,
    end_at: new Date(Date.parse(movement.observed_end_at) + 1).toISOString(), detail: 'observations', limit: 3 });
  assert.equal(route.length, 14);
  assert.ok(route[0].longitude < route[6].longitude);
  assert.ok(route[7].latitude < route[13].latitude);
  const onTurn = route[6];
  const expected = geographicEvidence(onTurn, historyGeography);
  assert.deepEqual(onTurn.geography.lines.map((r: any) => r.id), expected.lines.slice(0, 3).map(r => r.id));
  assert.ok(onTurn.geography.lines.every((r: any) => r.relation === 'near'));
  assert.ok(onTurn.geography.lines.some((r: any) => r.id === 'road-parallel'), 'do not force one road');
  assert.equal(summary.source, 'synthetic_fixture');
  assert.ok(summary.coverage.gaps.length >= 2, 'return path and overnight interval remain unknown');
});

test('empty, revoked, missing geography and partial history remain ordinary read results', () => {
  for (const [scenario, status] of [['empty', 'empty'], ['revoked', 'unavailable'], ['partial', 'available'], ['no-map', 'available']] as const) {
    const result = read(historyFixture(scenario, NOW).history);
    assert.equal(result.status, status);
    assert.equal('required_action' in result, false);
    assert.equal('request_recording' in result, false);
    if (scenario === 'no-map') assert.ok(result.entries[0].geography_samples.every((r: any) => r.status === 'unavailable'));
    if (scenario === 'partial') assert.ok(result.coverage.gaps.some((gap: any) => Date.parse(gap.before) - Date.parse(gap.after) > 120_000));
  }
  assert.match(locationHistoryTool.description, /do not automatically announce gaps/);
  assert.match(locationHistoryTool.description, /existing conversation\/memory/);
});

test('intentional stop rejects points and resumes as a separate observed interval', () => {
  const full = read(historyFixture('walk', NOW).history, { detail: 'observations' });
  const stoppedHistory = historyFixture('stopped', NOW).history;
  const stopped = read(stoppedHistory);
  assert.equal(stopped.coverage.observation_count, full.coverage.observation_count - 7);
  assert.ok(stopped.coverage.gaps.some((g: any) => g.reason === 'recording_boundary'));
  assert.equal(stoppedHistory.observe(fix('after-stop', NOW)).reason, 'recording_stopped');
});

test('sparse points and poor accuracy do not become a confirmed continuous stay', () => {
  const { history } = owner();
  history.observe(fix('a', NOW - 3_600_000));
  history.observe(fix('b', NOW - 60_000));
  assert.ok(read(history).entries.every((p: any) => p.kind === 'observations'));
  history.clear();
  for (let i = 0; i < 10; i++) history.observe(fix(`poor-${i}`, NOW - (10 - i) * 60_000, 10, 10, 150));
  assert.ok(read(history).entries.every((p: any) => p.kind !== 'candidate_stay'));
});

test('stationary jitter has observed bounds and tunable stay thresholds', () => {
  const history = new LocationHistoryReplay({ now: () => NOW, stayMs: 240_000, stayRadiusM: 20 });
  history.setRecording(true); history.setReadable(true);
  for (let i = 0; i < 5; i++) history.observe(fix(`j-${i}`, NOW - (5 - i) * 60_000, 10 + (i % 2) * 0.00001));
  const result = read(history).entries[0];
  assert.equal(result.kind, 'candidate_stay');
  assert.equal(result.observation_count, 5);
  assert.equal(result.observed_start_at, new Date(NOW - 300_000).toISOString());
  assert.equal('arrival_at' in result, false);
  assert.throws(() => new LocationHistoryReplay({ now: () => NOW, gapMs: NaN }));
});

test('duplicate retries and out-of-order arrival preserve sorted observed points', () => {
  const { history } = owner();
  const first = fix('a', NOW - 120_000), second = fix('b', NOW - 60_000);
  history.observe(second); history.observe(first);
  assert.equal(history.observe(first).reason, 'duplicate');
  const result = read(history, { detail: 'observations' });
  assert.deepEqual(result.entries.map((p: any) => p.id), ['a', 'b']);
  assert.throws(() => history.observe({ ...first, latitude: 11 }), (error: unknown) => error instanceof ToolRejection && error.reason === 'observation_conflict');
});

test('late uploads do not extend seven-day expiry; deletion and revocation fence cursors', () => {
  const { history, advance } = owner();
  assert.equal(history.observe(fix('expired', NOW - HISTORY_RETENTION_MS)).reason, 'expired');
  history.observe(fix('edge', NOW - HISTORY_RETENTION_MS + 10));
  history.observe(fix('fresh', NOW - 60_000));
  const page = read(history, { detail: 'observations', limit: 1 });
  advance(10);
  assert.throws(() => read(history, { cursor: page.next_cursor }), (error: unknown) => error instanceof ToolRejection && error.reason === 'history_cursor_expired');
  assert.equal(read(history).coverage.observation_count, 1);
  history.clear();
  assert.equal(read(history).status, 'empty');
  history.observe(fix('new', NOW));
  history.setReadable(false);
  assert.deepEqual(read(history, { cursor: page.next_cursor }).entries, []);
  history.setReadable(true);
  assert.throws(() => read(history, { cursor: page.next_cursor }));
});

test('bounded pagination preserves the full trace without repeating or skipping IDs', () => {
  const { history } = historyFixture('walk', NOW);
  const all = pages(history, { detail: 'observations', limit: 4 });
  assert.equal(all.length, read(history).coverage.observation_count);
  assert.equal(new Set(all.map(p => p.id)).size, all.length);
  assert.ok(all.every((p, i) => i === 0 || p.measured_at >= all[i - 1].measured_at));
  const page = read(history, { detail: 'observations', limit: 1 });
  assert.throws(() => read(history, { cursor: page.next_cursor, detail: 'observations' }));
});

test('page byte limit paginates verbose map evidence instead of returning an unbounded trace', () => {
  const name = '道'.repeat(1000);
  const history = new LocationHistoryReplay({ now: () => NOW, geography: fix => {
    const e = geographicEvidence(fix, historyGeography);
    return { ...e, source: name, attribution: name, license_url: name, limitations: [name, name, name, name],
      lines: Array.from({ length: 10 }, (_, i) => ({ id: `line-${i}`, kind: name, name, relation: 'near' as const, distance_m: i })) };
  } });
  history.setReadable(true); history.setRecording(true);
  for (let i = 0; i < 50; i++) history.observe(fix(`large-${i}`, NOW - (50 - i) * 30_000));
  const first = read(history, { detail: 'observations', limit: 50 });
  assert.ok(first.next_cursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= HISTORY_PAGE_BYTES);
  assert.equal(pages(history, { detail: 'observations', limit: 50 }).length, 50);
});

test('time queries use explicit offsets; timezone changes are evidence, not Mac defaults', () => {
  const { history } = owner();
  const at = Date.parse('2026-11-01T01:30:00-04:00');
  history.observe({ ...fix('dst-a', at), timezone: 'America/New_York', utc_offset_minutes: -240 });
  history.observe({ ...fix('dst-b', at + 60_000), timezone: 'America/New_York', utc_offset_minutes: -300 });
  const result = read(history, { start_at: '2026-11-01T00:00:00-04:00', end_at: '2026-11-02T00:00:00-05:00' });
  assert.equal(result.coverage.observation_count, 2);
  assert.equal(result.entries[0].timezone_changed, true);
  assert.equal(result.entries[0].timezone, 'America/New_York');
  assert.throws(() => read(history, { start_at: '2026-11-01T00:00:00' }));
  assert.throws(() => history.observe({ ...fix('bad-zone', NOW), timezone: 'unknown/timezone' }));
});

test('invalid ranges, live-source payloads and future points are rejected without echoing input', () => {
  const { history } = owner();
  for (const input of [{ limit: 51 }, { detail: 'route' }, { start_at: 'secret' },
    { start_at: '2020-01-01T00:00:00Z', end_at: '2026-01-01T00:00:00Z' },
    { start_at: '2026-11-03T00:00:00Z', end_at: '2026-11-02T00:00:00Z' }]) {
    assert.throws(() => read(history, input), (error: unknown) => error instanceof ToolRejection && !error.message.includes('secret'));
  }
  for (const input of [{ ...fix('bad', NOW), source: 'phone_location' }, fix('future', NOW + 1), fix('bad', NOW, 91), fix('bad', NOW, 10, 181), fix('bad', NOW, 10, 10, 201)]) {
    assert.throws(() => history.observe(input));
  }
});

test('replay capacity evicts old observations honestly; a fresh instance has no durable history', () => {
  const { history } = owner();
  for (let i = 0; i <= HISTORY_REPLAY_LIMIT; i++) history.observe(fix(`cap-${i}`, NOW - (HISTORY_REPLAY_LIMIT - i) * 1000));
  const result = read(history, { detail: 'observations', limit: 1 });
  assert.equal(result.coverage.observation_count, HISTORY_REPLAY_LIMIT);
  assert.equal(result.coverage.capacity_omissions, true);
  assert.equal(result.entries[0].id, 'cap-1');
  assert.equal(read(owner().history).status, 'empty');
});
