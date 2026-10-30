import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ciTarget, ciReceipt, ciHeadReceipt, matchesCI, selectCI, assertCI, collectCI} from '../scripts/ci-evidence.mjs';
import {branchAdmission} from '../scripts/branch-ci-admission.mjs';
const repository = 'YusukeIt0/dot-link', head = 'b'.repeat(40), base = 'a'.repeat(40);
const pr = {number: 7, head: {sha: head, ref: 'work', repo: {full_name: repository}}, base: {ref: 'main', sha: base}};
const target = ciTarget(pr);
const run = () => ({display_title: ciReceipt(target), id: 12, run_attempt: 1, event: 'pull_request', path: '.github/workflows/ci.yml',
  repository: {full_name: repository}, head_repository: {full_name: repository}, head_sha: head, head_branch: 'work',
  pull_requests: [{number: 7, head: {sha: head}, base: {ref: 'main', sha: base}}], status: 'completed', conclusion: 'success'});
const jobs = () => ['workflow-lint', 'test'].map(name => ({name, status: 'completed', conclusion: 'success'}));
test('actual workflow run-name and CI selector share the same receipt contract', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const expression = workflow.match(/^run-name: >-\n((?:[ \t]+.*\n)+)/m)?.[1].trim();
  const format = ciHeadReceipt({number: '{0}', head: '{1}', base: '{2}', baseRef: '{3}'});
  assert.equal(expression,
    "${{ github.event_name == 'pull_request' && format('" + format + "', github.event.pull_request.number, github.event.pull_request.head.sha, github.event.pull_request.base.sha, github.event.pull_request.base.ref) || format('CI v1 | push={0}', github.sha) }}",
    'run-name is machine-readable evidence: update the workflow and selector contract together');
  const actualFormat = expression.match(/&& format\('([^']+)'/)?.[1];
  for (const sample of [target, {...target, number: 12345, head: 'c'.repeat(40), base: 'd'.repeat(40), baseRef: 'feat/parent-branch'}]) {
    const values = [sample.number, sample.head, sample.base, sample.baseRef];
    const rendered = actualFormat.replace(/\{([0-3])\}/g, (_, index) => values[index]);
    assert.equal(rendered, ciHeadReceipt(sample));
    const source = {...run(), display_title: rendered, head_sha: sample.head,
      pull_requests: [{number: sample.number, head: {sha: sample.head}}]};
    assert.equal(matchesCI(source, sample), true);
  }
});
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
  assert.equal(currentCI('pull_request', event, event.pull_request, base, {status: 'ahead', merge_base_commit: {sha: base}}), true);
  for (const mutate of [p => p.state = 'closed', p => p.head.sha = base,
    p => p.base.sha = head, p => p.head.repo.full_name = 'other/fork']) {
    const current = structuredClone(event.pull_request); mutate(current);
    assert.equal(currentCI('pull_request', event, current, current.base.sha, {status: 'ahead', merge_base_commit: {sha: base}}), false);
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

test('obsolete metadata titles and unknown skips cannot revive older successful validation', () => {
  for (const display_title of [`CI ignored | pr=${target.number} | head=${head}`, 'Unknown skip']) {
    const skipped = {...run(), id: 20, display_title, conclusion: 'skipped'};
    const selected = selectCI([skipped, run()], target);
    assert.equal(selected.id, 20);
    assert.throws(() => assertCI(target, selected, jobs()), /Full PR CI/);
  }
});


test('fresh base ref overrides lagging PR metadata after parent advancement', () => {
  const event = {pull_request: {...pr, state: 'open'}};
  assert.equal(currentCI('pull_request', event, event.pull_request, 'c'.repeat(40)), false);
  assert.equal(currentCI('pull_request', event, event.pull_request), false);
});

const included = (baseSha = base) => ({status: 'ahead', merge_base_commit: {sha: baseSha}});
const headRun = () => ({...run(), display_title: ciHeadReceipt(target)});
test('v2 evidence follows the exact tested head only when the current base is included', () => {
  const source = headRun();
  source.display_title = ciHeadReceipt({...target, base: 'c'.repeat(40), baseRef: 'previous-parent'});
  assert.equal(matchesCI(source, target), true);
  assert.doesNotThrow(() => assertCI(target, source, jobs(), included()));
  for (const proof of [undefined, {}, {status: 'diverged', merge_base_commit: {sha: base}},
    {status: 'behind', merge_base_commit: {sha: base}}, included(head)]) {
    assert.throws(() => assertCI(target, source, jobs(), proof));
  }
  const legacy = {...source, display_title: source.display_title.replace('CI v2', 'CI v1')};
  assert.equal(matchesCI(legacy, target), false);
  assert.throws(() => assertCI(target, legacy, jobs(), included()));
});

test('v2 newest full result cannot be bypassed by a different dispatch base', () => {
  const older = headRun();
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    const latest = {...headRun(), id: 13, conclusion,
      display_title: ciHeadReceipt({...target, base: 'c'.repeat(40), baseRef: 'parent'})};
    assert.equal(selectCI([latest, older], target).id, 13);
    assert.throws(() => assertCI(target, latest, jobs(), included()));
  }
  for (const mutate of [r => r.event = 'push', r => r.head_sha = base,
    r => r.head_repository.full_name = 'other/repo', r => r.pull_requests = [],
    r => r.display_title = r.display_title.replace('pr=7', 'pr=8'),
    r => r.display_title = r.display_title.replace(`head=${head}`, `head=${base}`)]) {
    const r = headRun(); mutate(r); assert.throws(() => assertCI(target, r, jobs(), included()));
  }
});

test('v2 collection obtains fresh ancestry and fails closed when comparison is unavailable', () => {
  const source = headRun(), calls = [];
  const api = path => {
    calls.push(path);
    if (path === 'actions/runs/12') return source;
    if (path === `compare/${base}...${head}`) return included();
    return {workflow_runs: [source]};
  };
  const result = collectCI(pr, pr.base, api, () => [{jobs: jobs()}]);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.comparison, included());
  assert.ok(calls.includes(`compare/${base}...${head}`));
  assert.throws(() => collectCI(pr, pr.base, path => {
    if (path.startsWith('compare/')) throw Error('offline'); return api(path);
  }, () => [{jobs: jobs()}]), /offline/);
  assert.equal(collectCI(pr, pr.base, path => path.startsWith('compare/') ? included(head) : api(path),
    () => [{jobs: jobs()}]).status, 'held');
});

test('retargeted v2 head can run only with the current target already included', () => {
  const event = {pull_request: {...pr, state: 'open'}};
  const current = structuredClone(event.pull_request);
  current.base = {ref: 'new-parent', sha: 'c'.repeat(40)};
  assert.equal(currentCI('pull_request', event, current, current.base.sha, included(current.base.sha)), true);
  assert.equal(currentCI('pull_request', event, current, current.base.sha, included()), false);
  assert.equal(currentCI('pull_request', event, current, current.base.sha), false);
});
