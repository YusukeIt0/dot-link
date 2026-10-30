import test from 'node:test';
import assert from 'node:assert/strict';
import {ciTarget, ciReceipt, ciMetadataReceipt, matchesCI, selectCI, assertCI, collectCI} from '../scripts/ci-evidence.mjs';
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
  assert.equal(currentCI('pull_request', event, event.pull_request, base), true);
  for (const mutate of [p => p.state = 'closed', p => p.head.sha = base,
    p => p.base.sha = head, p => p.base.ref = 'other', p => p.head.repo.full_name = 'other/fork']) {
    const current = structuredClone(event.pull_request); mutate(current);
    assert.equal(currentCI('pull_request', event, current, current.base.sha), false);
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


test('fresh base ref overrides lagging PR metadata after parent advancement', () => {
  const event = {pull_request: {...pr, state: 'open'}};
  assert.equal(currentCI('pull_request', event, event.pull_request, 'c'.repeat(40)), false);
  assert.equal(currentCI('pull_request', event, event.pull_request), false);
});

import {verifyMetadataCI} from '../scripts/ci-metadata-check.mjs';
const metadataEvent = () => ({action: 'edited', changes: {title: {from: 'old'}}, pull_request: structuredClone(pr)});
const readCurrent = () => ({pr: {...pr, state: 'open'}, base: pr.base});
const ready = () => ({status: 'ready', run: run(), jobs: jobs()});

test('metadata receipts never replace actual full test evidence or certify themselves', () => {
  const metadata = {...run(), id: 50, display_title: ciMetadataReceipt(target)};
  assert.equal(selectCI([metadata], target), undefined);
  assert.equal(matchesCI(metadata, target), false);
  assert.throws(() => assertCI(target, metadata, jobs()));
  for (const conclusion of ['success', 'failure', 'cancelled', 'skipped']) {
    assert.equal(selectCI([metadata, {...run(), conclusion}], target).id, 12);
  }
  const otherBase = {...metadata, display_title: ciMetadataReceipt({...target, base: head})};
  assert.equal(selectCI([run(), otherBase], target).id, 12);
});

test('metadata verification rechecks current refs and exact full run attempt', async () => {
  let reads = 0, collects = 0;
  const result = await verifyMetadataCI({event: metadataEvent(), readCurrent: () => {reads++; return readCurrent();},
    collect: () => {collects++; return ready();}});
  assert.deepEqual(result, {id: 12, attempt: 1});
  assert.equal(reads, 3); assert.equal(collects, 2);
  for (const change of [r => r.run.run_attempt++, r => r.run.id++, r => r.status = 'held']) {
    let calls = 0;
    await assert.rejects(verifyMetadataCI({event: metadataEvent(), readCurrent,
      collect: () => {const value = ready(); if (++calls === 2) change(value); return value;}}), /changed/);
  }
});

test('metadata edits wait for an existing pending full run without rerunning tests', async () => {
  let clock = 0;
  const result = await verifyMetadataCI({event: metadataEvent(), readCurrent, now: () => clock,
    sleep: async ms => {clock += ms;}, timeoutMs: 30_000,
    collect: () => clock ? ready() : {status: 'held', run: {...run(), status: 'in_progress', conclusion: null}}});
  assert.equal(result.id, 12); assert.equal(clock, 15_000);
});

test('failed, cancelled, skipped, missing and unavailable source evidence cannot pass metadata checks', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    await assert.rejects(verifyMetadataCI({event: metadataEvent(), readCurrent,
      collect: () => ({status: 'held', run: {...run(), conclusion}, reason: 'source failed'})}), /source failed/);
  }
  let clock = 0;
  await assert.rejects(verifyMetadataCI({event: metadataEvent(), readCurrent, now: () => clock,
    sleep: async ms => {clock += ms;}, timeoutMs: 20_000,
    collect: () => ({status: 'held'})}), /bounded wait/);
  assert.equal(clock, 20_000);
  await assert.rejects(verifyMetadataCI({event: metadataEvent(), readCurrent,
    collect: () => {throw Error('API offline');}}), /API offline/);
});

test('base edits, code updates and moved or closed PRs cannot reuse metadata evidence', async () => {
  for (const event of [{...metadataEvent(), action: 'synchronize'},
    {...metadataEvent(), changes: {base: {ref: {from: 'other'}}}}]) {
    await assert.rejects(verifyMetadataCI({event, readCurrent, collect: ready}), /Only a metadata/);
  }
  for (const mutate of [x => x.pr.state = 'closed', x => x.pr.head.sha = base,
    x => x.base.sha = head, x => x.pr.base.ref = 'other', x => x.pr.head.repo.full_name = 'other/fork']) {
    await assert.rejects(verifyMetadataCI({event: metadataEvent(),
      readCurrent: () => {const x = structuredClone(readCurrent()); mutate(x); return x;}, collect: ready}), /stale/);
  }
  let reads = 0;
  await assert.rejects(verifyMetadataCI({event: metadataEvent(), collect: ready,
    readCurrent: () => {const x = structuredClone(readCurrent()); if (++reads === 3) x.base.sha = head; return x;}}), /stale/);
});
