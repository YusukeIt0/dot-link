import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealDelta } from '../src/keyboard-viewport.ts';

test('keyboard covering an input moves the entire field into the visible area', () => {
  assert.equal(revealDelta(390, 490, 0, 420), 86);
});
test('keyboard dismissal leaves an already visible input at its current position', () => {
  assert.equal(revealDelta(304, 404, 0, 780), 0);
});
test('native viewport panning is accounted for and oversized fields align at the top', () => {
  assert.equal(revealDelta(90, 190, 120, 540), -46);
  assert.equal(revealDelta(300, 800, 120, 400), 164);
});
