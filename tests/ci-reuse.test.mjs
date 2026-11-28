import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {discoverReuse, verifyReuse, reuseContext, sourceRunEligible, fullProductEvidence,
  fullProductStep, reuseMaxAgeMs, gitTreeProof, readmeTreeProof} from '../scripts/ci-reuse.mjs';
import {ciHeadReceipt, ciPath, ciRepository} from '../scripts/ci-evidence.mjs';

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

test('README reuse requires two trusted same-PR receipts, the live base and actual full execution', async () => {
  const base = 'd'.repeat(40);
  const target = {number: 7, headRef: 'feature', baseRef: 'main', base};
  const candidate = {...run, workflow_id: 12, display_title: ciHeadReceipt({...target, head: source})};
  const current = {...candidate, id: context.runId, head_sha: head, status: 'in_progress',
    conclusion: null, display_title: ciHeadReceipt({...target, head})};
  const pr = {number: target.number, state: 'open', head: {sha: head, ref: 'feature', repo: {full_name: ciRepository}},
    base: {sha: base, ref: 'main', repo: {full_name: ciRepository}}};
  const ref = {ref: 'refs/heads/main', object: {type: 'commit', sha: base}};
  const noTree = () => null;
  const readme = (previous, next, targetBase) => previous === source && next === head && targetBase === base ? tree : null;
  function reader({previous = candidate, running = current, pull = pr, branch = ref, rows = jobs, fresh = previous} = {}) {
    const history = api({candidate: previous, jobRows: rows, fresh});
    return path => {
      if (path === 'actions/runs/' + current.id) return running;
      if (path === 'pulls/' + target.number) return pull;
      if (path === 'git/ref/heads/main') return branch;
      return history(path);
    };
  }
  const ctx = {...context, target};
  const expected = {run: candidate.id, attempt: 1, source, tree, readmeOnly: true,
    url: 'https://github.com/YusukeIt0/dot-link/actions/runs/100/attempts/1', productSeconds: 180};
  assert.deepEqual(await discoverReuse(ctx, reader(), noTree, readme), expected);
  assert.deepEqual(await verifyReuse(candidate.id, ctx, reader(), noTree, readme), expected);
  for (const change of [
    {previous: {...candidate, display_title: ciHeadReceipt({...target, number: 8, head: source})}},
    {previous: {...candidate, display_title: ciHeadReceipt({...target, base: head, head: source})}},
    {previous: {...candidate, event: 'push', head_branch: 'main'}},
    {previous: {...candidate, head_branch: 'another-branch'}},
    {previous: {...candidate, triggering_actor: {...actor, id: 1}}},
    {running: {...current, id: 99}}, {running: {...current, run_attempt: 2}},
    {running: {...current, workflow_id: 13}}, {running: {...current, actor: {...actor, id: 1}}},
    {running: {...current, head_sha: source}}, {running: {...current, display_title: ''}},
    {pull: {...pr, state: 'closed'}}, {pull: {...pr, base: {...pr.base, sha: source}}},
    {pull: {...pr, head: {...pr.head, ref: 'changed'}}},
    {pull: {...pr, head: {...pr.head, repo: {full_name: 'other/repo'}}}},
    {branch: {...ref, object: {...ref.object, sha: source}}},
    {rows: [jobs[0], {...jobs[1], steps: []}]},
    {fresh: {...candidate, display_title: 'changed'}}]) {
    assert.equal(await verifyReuse(candidate.id, ctx, reader(change), noTree, readme), null, JSON.stringify(change));
  }
  assert.equal(await discoverReuse(context, reader(), noTree, readme), null);
  assert.equal(await discoverReuse(ctx, reader(), noTree, () => null), null);
});

test('only a same-repository pull_request event supplies a README target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-ci-event-'));
  const path = join(directory, 'event.json'), base = 'd'.repeat(40), repo = {full_name: ciRepository};
  const env = {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: ciRepository, GITHUB_RUN_ID: '200',
    GITHUB_RUN_ATTEMPT: '1', CI_HEAD: head, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: path};
  const pr = {number: 7, head: {ref: 'feature', sha: head, repo}, base: {ref: 'main', sha: base, repo}};
  try {
    writeFileSync(path, JSON.stringify({pull_request: pr}));
    assert.deepEqual(reuseContext(env, now).target, {number: 7, headRef: 'feature', baseRef: 'main', base});
    assert.equal(reuseContext({...env, GITHUB_EVENT_NAME: 'push'}, now).target, undefined);
    for (const patch of [{head: {...pr.head, sha: source}}, {head: {...pr.head, repo: {full_name: 'fork/repo'}}},
      {base: {...pr.base, ref: 'other'}}, {number: 0}]) {
      writeFileSync(path, JSON.stringify({pull_request: {...pr, ...patch}}));
      assert.equal(reuseContext(env, now).target, undefined);
    }
    writeFileSync(path, 'invalid');
    assert.equal(reuseContext(env, now).target, undefined);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('immutable Git proof permits exactly a regular README content edit under the integrated workflow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dot-ci-readme-'));
  const git = (...args) => execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const put = (file, text) => writeFileSync(join(dir, file), text);
  const commit = message => { git('add', '-A'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    mkdirSync(join(dir, '.github/workflows'), {recursive: true}); put(ciPath, 'workflow'); put('README.md', 'start');
    const base = commit('base');
    put('runtime.js', 'feature'); const source = commit('product');
    put('README.md', 'guide'); const head = commit('guide');
    assert.equal(readmeTreeProof(source, head, base, dir), git('rev-parse', head + '^{tree}'));
    assert.equal(readmeTreeProof(source, head, head, dir), null);
    assert.equal(readmeTreeProof(head, source, base, dir), null);
    put('runtime.js', 'more'); assert.equal(readmeTreeProof(source, commit('runtime'), base, dir), null);
    git('switch', '--detach', head); put(ciPath, 'other'); const workflow = commit('workflow');
    assert.equal(readmeTreeProof(source, workflow, base, dir), null);
    put('README.md', 'again'); assert.equal(readmeTreeProof(workflow, commit('later README'), base, dir), null);
    git('switch', '--detach', source); git('mv', 'README.md', 'renamed.md');
    assert.equal(readmeTreeProof(source, commit('rename'), base, dir), null);
    git('switch', '--detach', source); git('rm', 'README.md');
    const removed = commit('remove'); assert.equal(readmeTreeProof(source, removed, base, dir), null);
    put('README.md', 'created'); assert.equal(readmeTreeProof(removed, commit('add'), base, dir), null);
    git('rm', 'README.md'); symlinkSync('runtime.js', join(dir, 'README.md'));
    assert.equal(readmeTreeProof(source, commit('symlink'), base, dir), null);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
