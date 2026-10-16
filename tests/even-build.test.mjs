import test from 'node:test';
import assert from 'node:assert/strict';
import {evenBuild, assertBetaBuild} from '../scripts/lib/even-build.mjs';
test('ordinary builds stay visibly Beta; release requires explicit mode', () => {
  for (const mode of ['production', 'development', 'beta']) {
    const build = evenBuild('0.3.5', mode, 'commit', false);
    assert.equal(build.displayVersion, '0.3.5 Beta');
    assertBetaBuild(build, '0.3.5', {sourceCommit: 'commit', dirty: false});
  }
  const release = evenBuild('0.3.5', 'release', 'commit', false);
  assert.equal(release.displayVersion, '0.3.5');
  assert.throws(() => assertBetaBuild(release, '0.3.5', {sourceCommit: 'commit', dirty: false}), /Beta/);
});
test('packaging rejects stale versions, commits, and uncommitted build inputs', () => {
  const build = evenBuild('0.3.5', 'beta', 'commit', false);
  for (const [candidate, version, source] of [
    [build, '0.3.6', {sourceCommit: 'commit', dirty: false}],
    [build, '0.3.5', {sourceCommit: 'other', dirty: false}],
    [{...build, dirty: true}, '0.3.5', {sourceCommit: 'commit', dirty: false}],
    [build, '0.3.5', {sourceCommit: 'commit', dirty: true}],
  ]) assert.throws(() => assertBetaBuild(candidate, version, source));
});
