import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {discoverReuse, verifyReuse, reuseContext, sourceRunEligible, fullProductEvidence,
  fullProductStep, reuseMaxAgeMs, gitTreeProof} from '../scripts/ci-reuse.mjs';

const head = 'a'.repeat(40), source = 'b'.repeat(40), tree = 'c'.repeat(40);
const now = Date.parse('2026-11-10T12:00:00Z');
const context = {repository: 'YusukeIt0/dot-link', head, runId: 200, attempt: 1, now};
const actor = {id: 213780070, login: 'YusukeIt0'};
const run = {id: 100, run_attempt: 1, head_sha: source, head_branch: 'feature',
  repository: {full_name: context.repository}, head_repository: {full_name: context.repository},
  path: '.github/workflows/ci.yml', event: 'pull_request', actor, triggering_actor: actor,
  status: 'completed', conclusion: 'success', run_started_at: '2026-11-10T11:00:00Z', updated_at: '2026-11-10T11:04:00Z'};
const jobs = ['workflow-lint', 'test'].map(name => ({name, run_id: 100, head_sha: source,
  status: 'completed', conclusion: 'success', labels: [name === 'test' ? 'macos-15' : 'ubuntu-latest'],
  steps: name === 'test' ? [{name: fullProductStep, status: 'completed', conclusion: 'success',
    started_at: '2026-11-10T11:01:00Z', completed_at: '2026-11-10T11:04:00Z'}] : []}));
const proof = (s, h) => s === source && h === head ? tree : null;
function api({candidate = run, listed = [candidate], latest = [candidate], jobRows = jobs, fresh = candidate, total = jobRows.length} = {}) {
  let reads = 0;
  return async path => {
    if (path === 'actions/workflows/ci.yml/runs?per_page=100&page=1') return {workflow_runs: listed};
    if (path === `actions/runs/${candidate.id}`) return ++reads === 1 ? candidate : fresh;
    if (path.includes('head_sha=')) return {workflow_runs: latest, total_count: latest.length};
    if (path.includes('/jobs?')) return {jobs: jobRows, total_count: total};
    throw new Error(`Unexpected request ${path}`);
  };
}

test('same-tree full execution can cover a new commit, but preserves source identity', async () => {
  const result = await discoverReuse(context, api(), proof);
  assert.deepEqual(result, {run: 100, attempt: 1, source, tree,
    url: 'https://github.com/YusukeIt0/dot-link/actions/runs/100/attempts/1', productSeconds: 180});
  assert.equal((await verifyReuse(100, context, api(), proof)).run, 100);
  assert.equal((await discoverReuse(context, api({listed: [{...run, id: context.runId, status: 'in_progress'}, run]}), proof)).run, 100);
});

test('untrusted, old, failed, incomplete and foreign runs cannot supply evidence', () => {
  for (const patch of [
    {actor: {...actor, id: 1}}, {triggering_actor: {...actor, login: 'other'}},
    {repository: {full_name: 'other/repo'}}, {head_repository: {full_name: 'fork/repo'}},
    {path: '.github/workflows/branch-ci.yml'}, {event: 'workflow_dispatch'},
    {event: 'push', head_branch: 'feature'}, {id: context.runId}, {run_attempt: 0},
    {status: 'in_progress'}, {conclusion: 'failure'}, {conclusion: 'cancelled'},
    {run_started_at: new Date(now - reuseMaxAgeMs - 1).toISOString()},
    {run_started_at: 'invalid'}, {updated_at: new Date(now + 1000).toISOString()},
    {head_sha: 'invalid'},
  ]) assert.equal(sourceRunEligible({...run, ...patch}, context), false, JSON.stringify(patch));
  assert.equal(sourceRunEligible({...run, event: 'push', head_branch: 'main'}, context), true);
});

test('only executed full macOS product work qualifies, never narrowed or reused success', () => {
  assert.equal(fullProductEvidence(jobs, run).seconds, 180);
  for (const rows of [[], jobs.slice(0, 1), [...jobs, jobs[1]],
    [jobs[0], {...jobs[1], conclusion: 'skipped'}],
    [jobs[0], {...jobs[1], head_sha: head}],
    [jobs[0], {...jobs[1], labels: ['ubuntu-latest']}],
    [jobs[0], {...jobs[1], steps: []}],
    [jobs[0], {...jobs[1], steps: [{...jobs[1].steps[0], conclusion: 'skipped'}]}],
    [jobs[0], {...jobs[1], steps: [{...jobs[1].steps[0], name: 'Run bounded or reused validation'}]}],
    [jobs[0], {...jobs[1], steps: [{...jobs[1].steps[0], completed_at: 'invalid'}]}],
  ]) assert.equal(fullProductEvidence(rows, run), null);
});

test('newer source failures and retry/status changes cannot revive an old success', async () => {
  const failed = {...run, id: 101, conclusion: 'failure'};
  assert.equal(await verifyReuse(100, context, api({latest: [failed, run]}), proof), null);
  assert.equal(await discoverReuse(context, api({listed: [failed, run]}), proof), null);
  assert.equal(await verifyReuse(100, context, api({fresh: {...run, run_attempt: 2}}), proof), null);
  assert.equal(await verifyReuse(100, context, api({fresh: {...run, status: 'in_progress'}}), proof), null);
  assert.equal(await verifyReuse(100, context, api({total: 101}), proof), null);
});

test('missing trees, API errors and incomplete lookup retain full validation', async () => {
  assert.equal(await discoverReuse(context, api(), () => null), null);
  assert.equal(await discoverReuse(context, async () => { throw new Error('offline'); }, proof), null);
  assert.equal(await discoverReuse(context, async () => ({}), proof), null);
  // Once the runner was allocated for reuse, lost evidence must fail the consumer.
  await assert.rejects(verifyReuse(100, context, async () => { throw new Error('offline'); }, proof), /offline/);
});

test('local runs and manual workflow retries always perform full work', () => {
  const env = {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: context.repository, CI_HEAD: head,
    GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1'};
  assert.deepEqual(reuseContext(env, now), context);
  for (const patch of [{GITHUB_ACTIONS: ''}, {GITHUB_REPOSITORY: 'fork/repo'},
    {GITHUB_RUN_ATTEMPT: '2'}, {CI_HEAD: 'bad'}, {GITHUB_RUN_ID: 'bad'}]) {
    assert.equal(reuseContext({...env, ...patch}, now), null);
  }
});

test('Git proof supports a revert and child merge, excludes changed content and unrelated history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dot-ci-reuse-'));
  const git = args => execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  try {
    git(['init', '-b', 'main']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'file'), 'accepted'); git(['add', '.']); git(['commit', '-m', 'accepted']);
    const accepted = git(['rev-parse', 'HEAD']);
    git(['switch', '-c', 'child']);
    writeFileSync(join(dir, 'file'), 'changed'); git(['commit', '-am', 'changed']);
    const changed = git(['rev-parse', 'HEAD']);
    assert.equal(gitTreeProof(accepted, changed, dir), null);
    git(['revert', '--no-edit', 'HEAD']);
    const reverted = git(['rev-parse', 'HEAD']);
    assert.equal(gitTreeProof(accepted, reverted, dir), git(['rev-parse', 'HEAD^{tree}']));
    git(['switch', 'main']); git(['merge', '--no-ff', 'child', '-m', 'integrate']);
    const merged = git(['rev-parse', 'HEAD']);
    assert.ok(gitTreeProof(reverted, merged, dir));
    git(['switch', '--orphan', 'unrelated']); writeFileSync(join(dir, 'file'), 'accepted');
    git(['add', '.']); git(['commit', '-m', 'same bytes, unrelated']);
    assert.equal(gitTreeProof(accepted, git(['rev-parse', 'HEAD']), dir), null);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
