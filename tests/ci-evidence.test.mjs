import test from 'node:test';
import assert from 'node:assert/strict';
import {ciTarget, ciReceipt, matchesCI, selectCI, assertCI, collectCI} from '../scripts/ci-evidence.mjs';
import {branchAdmission} from '../scripts/branch-ci-admission.mjs';
const repository = 'YusukeIt0/dot-link', head = 'b'.repeat(40), base = 'a'.repeat(40);
const pr = {number: 7, head: {sha: head, ref: 'work', repo: {full_name: repository}}, base: {ref: 'main', sha: base}};
const target = ciTarget(pr);
const run = () => ({display_title: ciReceipt(target), id: 12, run_attempt: 1, event: 'pull_request', path: '.github/workflows/ci.yml',
  repository: {full_name: repository}, head_repository: {full_name: repository}, head_sha: head, head_branch: 'work',
  pull_requests: [{number: 7, head: {sha: head}, base: {ref: 'main', sha: base}}], status: 'completed', conclusion: 'success'});
const jobs = () => ['workflow-lint', 'test'].map(name => ({name, status: 'completed', conclusion: 'success'}));
test('PR identity includes repository, head and exact target; pushes never certify PRs', () => {
  assert.equal(matchesCI(run(), target), true);
  for (const mutate of [r => r.event = 'push', r => r.head_sha = base, r => r.head_branch = 'other',
    r => r.repository.full_name = 'other/repo', r => r.head_repository.full_name = 'other/fork',
    r => r.path = 'other.yml', r => r.pull_requests = [], r => r.pull_requests[0].number++,
    r => r.pull_requests[0].head.sha = base, r => r.pull_requests[0].base.sha = head,
    r => r.pull_requests[0].base.ref = 'parent']) {
    const r = run(); mutate(r); assert.equal(matchesCI(r, target), false, mutate.toString());
  }
  assert.throws(() => ciTarget({...pr, head: {sha: head}}));
});
test('newest canonical result wins regardless of success or response order', () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    const latest = {...run(), id: 13, conclusion};
    for (const rows of [[run(), latest], [latest, run()]]) {
      assert.equal(selectCI(rows, target).id, 13);
      assert.throws(() => assertCI(target, selectCI(rows, target), jobs()));
    }
  }
  assert.equal(selectCI([{...run(), id: 99, event: 'push', conclusion: 'cancelled'}, run()], target).id, 12);
  assert.equal(selectCI([{...run(), run_attempt: 2, conclusion: 'cancelled'}, run()], target).run_attempt, 2);
});
test('every required job must exist exactly once and actually succeed', () => {
  assert.doesNotThrow(() => assertCI(target, run(), jobs()));
  for (const rows of [[], jobs().slice(1), [...jobs(), jobs()[0]], jobs().map(j => ({...j, conclusion: 'skipped'})),
    jobs().map(j => ({...j, status: 'in_progress'}))]) assert.throws(() => assertCI(target, run(), rows));
});
test('enumeration reaches later pages and pins jobs to the selected attempt', () => {
  const calls = [];
  const result = collectCI(pr, pr.base, path => {
    if (path === 'actions/runs/12') return run();
    calls.push(path);
    return {total_count: 101, workflow_runs: path.endsWith('page=1') ? Array.from({length: 100}, (_, i) => ({...run(), id: i + 20, event: 'push'})) : [run()]};
  }, path => {assert.match(path, /\/12\/attempts\/1\/jobs/); return [{jobs: jobs()}];});
  assert.equal(calls.length, 2); assert.equal(result.status, 'ready');
  assert.throws(() => collectCI(pr, pr.base, () => ({total_count: 1001, workflow_runs: []}), () => []));
  assert.throws(() => collectCI(pr, pr.base, () => {throw new Error('API unavailable');}, () => []));
});
test('branch admission omits only obsolete heads or matching open PRs; errors retain tests', async () => {
  const context = {repository, ref: 'work', head};
  const get = rows => async path => path.startsWith('git/') ? {object: {sha: head}} : rows;
  assert.equal((await branchAdmission(context, get([{...pr, state: 'open'}]))).run, false);
  for (const rows of [[], [{...pr, state: 'closed'}], [{...pr, state: 'open', head: {...pr.head, sha: base}}],
    [{...pr, state: 'open', head: {...pr.head, repo: {full_name: 'external/fork'}}}]]) {
    assert.equal((await branchAdmission(context, get(rows))).run, true);
  }
  assert.equal((await branchAdmission(context, async () => {throw Error('offline');})).run, true);
  assert.equal((await branchAdmission(context, async () => ({object: {sha: base}}))).run, false);
});

test('malformed ref metadata cannot suppress branch validation', async () => {
  assert.equal((await branchAdmission({repository, ref: 'work', head}, async () => ({}))).run, true);
});

import {currentCI} from '../scripts/ci-current.mjs';
test('late starts and stale retries cannot execute expensive tests against a moved PR/ref', () => {
  const event = {pull_request: {...pr, state: 'open'}};
  assert.equal(currentCI('pull_request', event, event.pull_request), true);
  for (const mutate of [p => p.state = 'closed', p => p.head.sha = base,
    p => p.base.sha = head, p => p.base.ref = 'other', p => p.head.repo.full_name = 'other/fork']) {
    const current = structuredClone(event.pull_request); mutate(current);
    assert.equal(currentCI('pull_request', event, current), false);
  }
  assert.equal(currentCI('push', {after: head}, {object: {sha: head}}), true);
  assert.equal(currentCI('push', {after: head}, {object: {sha: base}}), false);
  assert.equal(currentCI('push', {}, {}), false);
});

test('mutable PR metadata cannot relabel a historical run as a different tested base', () => {
  const old = run(); old.display_title = ciReceipt({...target, baseRef: 'old-parent', base: 'c'.repeat(40)});
  // GitHub changed pull_requests to the current base, while dispatch title stayed fixed.
  assert.equal(matchesCI(old, target), false);
  assert.equal(selectCI([old], target), undefined);
  const valid = {...run(), id: 20};
  const newerUnknown = {...run(), id: 21, display_title: 'Missing receipt'};
  assert.equal(selectCI([valid, newerUnknown], target).id, 21);
  assert.throws(() => assertCI(target, newerUnknown, jobs()));
  assert.equal(selectCI([valid, {...old, id: 22}], target).id, 20);
});

test('newer incomplete association holds instead of falling back; attempt churn is rejected', () => {
  const newer = {...run(), id: 13, pull_requests: []};
  assert.equal(selectCI([run(), newer], target).id, 13);
  assert.throws(() => assertCI(target, newer, jobs()));
  assert.throws(() => collectCI(pr, pr.base, path => path === 'actions/runs/12'
    ? {...run(), run_attempt: 2, status: 'queued', conclusion: null} : {workflow_runs: [run()]},
    () => [{jobs: jobs()}]), /changed while collecting/);
});

test('explicit metadata-only runs do not replace canonical validation; arbitrary skips hold', () => {
  const ignored = {...run(), id: 20, display_title: `CI ignored | pr=${target.number} | head=${head}`, conclusion: 'skipped'};
  assert.equal(selectCI([ignored, run()], target).id, 12);
  assert.equal(selectCI([{...ignored, display_title: 'Unknown skip'}, run()], target).id, 20);
});
