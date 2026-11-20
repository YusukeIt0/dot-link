import assert from 'node:assert/strict';
import test from 'node:test';
import { historyExpiry, type HistoryPeriod } from '../server/history/retention.ts';

test('retention preserves the UTC time and clamps days at calendar month ends', () => {
  const examples: [string, HistoryPeriod, string][] = [
    ['2024-03-09T12:04:05.678-05:00', '7d', '2024-03-16T17:04:05.678Z'],
    ['2024-01-31T23:59:59.999Z', '1m', '2024-02-29T23:59:59.999Z'],
    ['2025-01-31T06:00:01.023Z', '1m', '2025-02-28T06:00:01.023Z'],
    ['2024-12-15T12:00:00.000Z', '1m', '2025-01-15T12:00:00.000Z'],
    ['2023-08-31T01:02:03.004Z', '6m', '2024-02-29T01:02:03.004Z'],
    ['2024-02-29T01:02:03.004Z', '1y', '2025-02-28T01:02:03.004Z'],
  ];
  for (const [anchor, period, expected] of examples) {
    assert.equal(historyExpiry(Date.parse(anchor), period), Date.parse(expected), `${anchor} + ${period}`);
  }
});

test('unrepresentable retention anchors and deadlines are rejected', () => {
  for (const anchor of [NaN, Infinity, 0.5, 8.64e15]) {
    assert.throws(() => historyExpiry(anchor, '7d'), RangeError);
  }
  assert.throws(() => historyExpiry(8.64e15, '1m'), RangeError);
});
