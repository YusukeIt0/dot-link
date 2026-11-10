import test from 'node:test';
import assert from 'node:assert/strict';
import {endpointReader} from '../scripts/review-endpoints.mjs';

const source = 'a'.repeat(40), target = 'b'.repeat(40), oldTree = 'c'.repeat(40), newTree = 'd'.repeat(40);
const file = (path, sha = 'e'.repeat(40), mode = '100644', type = 'blob') => ({path, sha, mode, type});
function fixture(before, after, mutate = () => {}) {
  const responses = {
    [`git/commits/${source}`]: {sha: source, tree: {sha: oldTree}},
    [`git/commits/${target}`]: {sha: target, tree: {sha: newTree}},
    [`git/trees/${oldTree}?recursive=1`]: {sha: oldTree, truncated: false, tree: before},
    [`git/trees/${newTree}?recursive=1`]: {sha: newTree, truncated: false, tree: after},
  };
  mutate(responses);
  const requests = [];
  return {requests, reader: endpointReader(path => {requests.push(path); assert.ok(path in responses, path); return responses[path];})};
}

test('endpoint comparison covers content, modes, submodules and moves without merge-base assumptions', () => {
  const before = [file('unchanged'), file('modified'), file('removed'), file('mode'), file('old-name'), file('module', undefined, '160000', 'commit')];
  const after = [file('unchanged'), file('modified', 'f'.repeat(40)), file('added'), file('mode', undefined, '120000'),
    file('new-name'), file('module', 'f'.repeat(40), '160000', 'commit')];
  const {reader, requests} = fixture(before, after);
  const result = reader.compare(source, target);
  assert.equal(result.complete, true);
  assert.equal(result.comparison_kind, 'endpoint-content');
  assert.deepEqual(result.files.map(f => [f.filename, f.status]), [
    ['added', 'added'], ['mode', 'modified'], ['modified', 'modified'], ['module', 'modified'],
    ['new-name', 'added'], ['old-name', 'removed'], ['removed', 'removed'],
  ]);
  assert.equal(result.files[1].before_mode, '100644');
  assert.equal(result.files[1].after_mode, '120000');
  assert.deepEqual(reader.compare(source, target), result);
  assert.equal(requests.length, 4, 'immutable objects are reused within one collection');
});

test('identical endpoint trees prove no content delta across different commit identities', () => {
  const {reader, requests} = fixture([], [], r => r[`git/commits/${target}`].tree.sha = oldTree);
  const result = reader.compare(source, target);
  assert.equal(result.source_tree, result.target_tree);
  assert.equal(result.complete, true);
  assert.deepEqual(result.files, []);
  assert.equal(requests.length, 2, 'equal tree identity needs no file enumeration');
});

test('truncated, malformed, over-budget or mismatched trees disclose no partial delta', () => {
  for (const mutate of [
    r => r.truncated = true, r => delete r.truncated, r => r.sha = oldTree,
    r => r.tree.push(file('../escape')), r => r.tree.push(file('/absolute')),
    r => r.tree.push(file('duplicate'), file('duplicate')),
    r => r.tree[0].mode = 'unknown', r => r.tree[0].sha = 'branch',
    r => r.tree = Array.from({length: 10_001}, (_, i) => file(`files/${i}`)),
    r => r.padding = 'x'.repeat(2_000_000),
  ]) {
    const {reader} = fixture([file('old')], [file('changed')], r => mutate(r[`git/trees/${newTree}?recursive=1`]));
    const result = reader.compare(source, target);
    assert.equal(result.complete, false);
    assert.deepEqual(result.files, []);
  }
  const {reader} = fixture([], Array.from({length: 300}, (_, i) => file(`added/${i}`)));
  assert.equal(reader.compare(source, target).complete, false);
});

test('invalid commit identities and API failures fail collection rather than imply equality', () => {
  const {reader} = fixture([], [], r => r[`git/commits/${source}`].sha = target);
  assert.throws(() => reader.compare(source, target), /commit tree/);
  assert.throws(() => reader.compare('main', target), /Invalid evidence commit/);
  assert.throws(() => endpointReader(() => {throw Error('API unavailable');}).compare(source, target), /API unavailable/);
});
