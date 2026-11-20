// Manual benchmark: node scripts/bench-location-history.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { LocationHistoryStore } from '../server/history/store.ts';

const rows = 50_000;
const spacing = 10_000;
const start = Date.UTC(2025, 0, 1);
const owner = '0'.repeat(64);
const options = { now: () => start + rows * spacing, ownerAuthorized: id => id === owner, announce: async () => {} };
const directory = mkdtempSync(join(tmpdir(), 'dot-link-history-bench-'));
const iso = time => new Date(time).toISOString();

function measure(trials, run) {
  const elapsed = [];
  for (let i = 0; i < trials + 2; i++) {
    const before = performance.now();
    run(i);
    if (i >= 2) elapsed.push(performance.now() - before);
  }
  elapsed.sort((a, b) => a - b);
  const percentile = fraction => Number(elapsed[Math.ceil(fraction * trials) - 1].toFixed(3));
  return { trials, p50_ms: percentile(0.5), p95_ms: percentile(0.95) };
}

try {
  const db = new DatabaseSync(join(directory, 'history.sqlite'));
  try {
    // Start with the published v1 layout to measure first-open migration separately.
    db.exec(`CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE observations (id TEXT PRIMARY KEY, measured INTEGER NOT NULL, data TEXT NOT NULL, geography TEXT);
      CREATE INDEX observation_time ON observations(measured); PRAGMA user_version=1;`);
    db.prepare('INSERT INTO state(id,data) VALUES(1,?)').run(JSON.stringify({
      version: 1, owner, enabled: true, capacityOmitted: false, consentAt: start, recordingEpoch: 1,
    }));
    const insert = db.prepare('INSERT INTO observations(id,measured,data) VALUES(?,?,?)');
    db.exec('BEGIN');
    for (let i = 0; i < rows; i++) {
      const id = String(i), time = start + i * spacing;
      insert.run(id, time, JSON.stringify({
        id, source: 'phone_location', measured_at: iso(time), received_at: iso(time + 2_000),
        latitude: 0, longitude: i / 1_000_000, accuracy: 10,
        timezone: 'Etc/UTC', utc_offset_minutes: 0, recording_epoch: 1,
      }));
    }
    db.exec('COMMIT');
  } finally { db.close(); }

  const startAndCheck = () => {
    const reopened = new LocationHistoryStore(directory, options);
    try { assert.equal(reopened.status(owner).historyCount, rows); }
    finally { reopened.close(); }
  };
  const firstOpen = performance.now();
  startAndCheck();
  const migration_ms = Number((performance.now() - firstOpen).toFixed(3));
  const startup = measure(7, startAndCheck);
  const store = new LocationHistoryStore(directory, options);
  try {
    const detail = measure(25, i => {
      const from = start + (1_000 + 64 * i) * spacing;
      const result = store.read({ start_at: iso(from), end_at: iso(from + 180_000), detail: 'observations' });
      assert.equal(result.entries.length, 18);
      assert.equal(result.coverage.observation_count, 18);
    });
    const phoneTime = measure(15, () => {
      const result = store.readPhoneTime(['2025-01-03'], owner);
      assert.equal(result.evidence.status, 'available');
      assert.equal(result.allowed(), true);
    });
    const summary = measure(7, () => {
      const result = store.read();
      assert.equal(result.coverage.observation_count, rows);
    });
    console.log(JSON.stringify({ node: process.version, rows, spacing_ms: spacing, migration_ms, startup, detail, phoneTime, summary }, null, 2));
  } finally { store.close(); }
} finally { rmSync(directory, { recursive: true, force: true }); }
