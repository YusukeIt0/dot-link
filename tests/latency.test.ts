import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LatencyLog } from '../server/latency.ts';
import { TimingTracker } from '../src/timing.ts';

test('timings contain bounded metadata only and distinguish client clock from server receipt', t => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-timing-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'timing.jsonl'), log = new LatencyLog(path), id = randomUUID();
  log.mark(id, 'reply_stored');
  log.client({ id, events: [{ stage: 'recording_stop', at: 1234, elapsedMs: 0 }, { stage: 'g2_update_ack', at: 2234, elapsedMs: 1000 }] });
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(row => JSON.parse(row));
  assert.equal(rows.length, 3);
  assert.equal(rows[2].clientAt, 2234); assert.equal(rows[2].elapsedMs, 1000); assert(rows[2].at > 2234);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const value of [
    { id, events: [{ stage: 'reply_received', at: 1, elapsedMs: 1, text: 'private' }] },
    { id, text: 'private', events: [{ stage: 'reply_received', at: 1, elapsedMs: 1 }] },
    { id, events: [{ stage: 'private text', at: 1, elapsedMs: 1 }] },
    { id, events: Array(17).fill({ stage: 'reply_received', at: 1, elapsedMs: 1 }) },
  ]) assert.throws(() => log.client(value));
  assert.equal(readFileSync(path, 'utf8').includes('private'), false);
  // Diagnostics failing cannot fail the voice exchange.
  assert.doesNotThrow(() => new LatencyLog(join(dir, 'missing', 'file')).mark(id, 'reply_stored'));
});

test('client timings retain first observation and bound history without keeping message text', () => {
  const tracker = new TimingTracker(), id = randomUUID();
  tracker.mark(id, 'recording_stop'); tracker.mark(id, 'reply_received'); tracker.mark(id, 'reply_received');
  assert.deepEqual(tracker.report(id)?.events.map(e => e.stage), ['recording_stop', 'reply_received']);
  const copy = tracker.report(id)!; copy.events.length = 0;
  assert.equal(tracker.report(id)?.events.length, 2);
  for (let i = 0; i < 100; i++) tracker.mark(randomUUID(), 'recording_stop');
  assert.equal(tracker.report(id), undefined);
});
