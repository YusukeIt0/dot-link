import assert from 'node:assert/strict';
import test from 'node:test';
import { delta, exportPoses, phoneAngles, readFix, summary } from './angles.js';

test('iOS magnetic zero is valid and uncalibrated or relative readings stay unavailable', () => {
  assert.deepEqual(phoneAngles({ webkitCompassHeading: 0, webkitCompassAccuracy: 4, alpha: 211 }),
    { webkitCompass: { deg: 0, accuracy: 4 } });
  assert.deepEqual(phoneAngles({ webkitCompassHeading: 210, webkitCompassAccuracy: -1, alpha: 50 }), {});
  assert.deepEqual(phoneAngles({ alpha: null, beta: 0, gamma: 0, absolute: true }), {});
  assert.deepEqual(phoneAngles({ type: 'deviceorientationabsolute', alpha: 270, beta: 3, gamma: -1 }),
    { flatAbsoluteAlpha: { deg: 90, accuracy: null } });
  assert.deepEqual(phoneAngles({ type: 'deviceorientationabsolute', alpha: 270, beta: 60, gamma: 0 }), {});
});

test('reads only heading and measurement time from native fixes, preserving unknowns', () => {
  const stamp = 1764000000000;
  for (const timestamp of [stamp, stamp / 1000]) {
    const native = new Proxy({ timestamp, heading: 0 }, { get(o, k) {
      assert.ok(['heading', 'timestamp'].includes(k));
      return o[k];
    } });
    assert.deepEqual(readFix(native, stamp + 250), { state: 'fix with heading', stamp, ageMs: 250,
      sample: { deg: 0, accuracy: null } });
  }
  assert.equal(readFix(null, stamp).state, 'no fix');
  assert.equal(readFix({ heading: -1 }, stamp).state, 'fix without heading');
  assert.equal(readFix({ heading: null }, stamp).sample, null);
  assert.equal(readFix({ heading: 0, timestamp: 800 }, stamp).ageMs, null);
});

test('uses circular means and exports relative results only', () => {
  const each = deg => ({ deg, accuracy: 6 });
  const crossing = summary([each(359), each(1)]);
  assert.equal(delta(crossing.center, 0), 0);
  assert.equal(crossing.spread, 1);
  assert.equal(summary([each(90), each(270)]).center, null);
  const poses = [333, 65, 335].map(deg => ({
    sources: { webkitCompass: summary([each(deg)]), flatAbsoluteAlpha: summary([]), evenLocation: summary([each(deg)]) },
    fix: { reused: false, ageMs: 50 },
  }));
  const good = exportPoses(poses);
  assert.deepEqual(good.webkitCompass.changes, [0, 92, 2]);
  assert.equal(good.webkitCompass.outcome, 'tracks right turn and return');
  assert.equal(good.flatAbsoluteAlpha.outcome, 'incomplete');
  assert.ok(!JSON.stringify(good).includes('333'));
  poses[1].fix.reused = true;
  assert.equal(exportPoses(poses).evenLocation.outcome, 'cached or stale fix');
  assert.equal(exportPoses([]).evenLocation.outcome, 'incomplete');
});
