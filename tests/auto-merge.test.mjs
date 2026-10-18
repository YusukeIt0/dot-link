import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, collect, mergeEligible, mergeWithReassessment, snapshotHash, assertActivation, protectedChanges, deviceAffected} from '../scripts/auto-merge.mjs';
import {policy, acceptanceMarker, scopeDigest, hash} from '../scripts/review-evidence.mjs';
import {fingerprintPR, latestReceipt} from '../scripts/check-review-before-merge.mjs';

const main = 'a'.repeat(40), head = 'b'.repeat(40), repository = 'YusukeIt0/dot-link';
const owner = {...policy.trustedMaintainers[0], type: 'User'};
const env = {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository,
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/auto-merge.yml@refs/heads/main`,
  DOTLINK_AUTO_MERGE_ENABLED: policy.activationValue, AUTO_MERGE_TOKEN: 'fake-token'};
function fixture() {
  const issue = {number: 73, title: 'Agreed work', body: 'Document an existing behavior', state: 'open'};
  const record = {version: 1, head, scope: {approved: true, issue: 73, digest: scopeDigest(issue, [])},
    requirements: [{id: 'R1', expected: 'Describe the existing behavior accurately'}],
    evidence: [{kind: 'static', result: 'pass', requirements: ['R1'], reference: 'Source inspection', details: 'Guide matches source'}], product_decisions: []};
  const comments = [{id: 42, node_id: 'comment42', updated_at: '2026-10-17', revision_verified: true, revision_author: owner, user: owner, body: `${acceptanceMarker}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``}];
  const pr = {number: 74, title: 'Document behavior', body: 'Closes #73', user: {...owner}, state: 'open', draft: false,
    changed_files: 1, base: {ref: 'main'}, head: {sha: head, ref: 'work', repo: {full_name: repository}}, mergeable: true, mergeable_state: 'clean'};
  const scope = {number: 73, digest: record.scope.digest};
  const fingerprint = fingerprintPR(pr, main, comments, undefined, scope, []);
  const acceptance = {status: 'ready', comment_id: 42, author: owner.login, record, digest: hash(record)};
  const assessment = {scope: 'aligned', device: 'not-required', requirements: [{id: 'R1', status: 'covered', reason: 'Matches source'}], gaps: [], architecture: [], related: []};
  const quality = {version: 1, findings: 0, assessment, acceptance: {status: 'ready', comment_id: 42, digest: hash(record), scope_digest: scope.digest}};
  comments.push({id: 50, node_id: 'comment50', updated_at: '2026-10-17', revision_verified: true, revision_author: {id: 98765, login: 'dotsweeper[bot]', type: 'Bot'}, user: {id: 98765, login: 'dotsweeper[bot]', type: 'Bot'}, body:
    `<!-- dot-link-opus-review:v1 -->\n<!-- dot-link-review-owner:456:1 -->\n## dotsweeper review · Complete\n\n<!-- dot-link-review-input:head=${head};main=${main};input=${fingerprint} -->\n\n<!-- dot-link-review-quality:${Buffer.from(JSON.stringify(quality)).toString('base64url')} -->`});
  const run = {id: 456, path: '.github/workflows/claude-review.yml', repository: {full_name: repository}, status: 'completed', conclusion: 'success', run_attempt: 1};
  const jobs = ['intake', 'review', 'report'].map(name => ({name, status: 'completed', conclusion: 'success'}));
  const ciRun = {id: 789, event: 'push', head_branch: 'work', head_sha: head, path: '.github/workflows/ci.yml',
    repository: {full_name: repository}, status: 'completed', conclusion: 'success'};
  const ciJobs = policy.requiredJobs.map(name => ({name, status: 'completed', conclusion: 'success'}));
  const protection = {required_status_checks: {strict: true, checks: [{context: 'test', app_id: 15368}]},
    enforce_admins: {enabled: true}, allow_force_pushes: {enabled: false}, allow_deletions: {enabled: false}, required_pull_request_reviews: {required_approving_review_count: 0}};
  return {issue, pr, main, scope, feedback: [], comments, receipt: latestReceipt(comments, 98765), run, jobs,
    files: [{filename: 'docs/guide.md', status: 'modified'}], versionChanges: {},
    context: {version: 1, fingerprint, related: [], ci: [], scope: {...issue, digest: scope.digest}, acceptance},
    ciRun, ciJobs, protection, checks: [{name: 'test', bucket: 'pass'}], reviews: [], ancestry: {status: 'ahead', merge_base_commit: {sha: main}}};
}
function clientFor(s, change) {
  let reads = 0; const merges = [];
  return {merges, graphql() { return {data: {repository: {pullRequest: {headRefOid: s.pr.head.sha, closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}}}; }, readNode(id) {
    const r = s.comments.find(x => x.node_id === id);
    const actor = user => ({__typename: user.type, login: user.login, databaseId: user.id});
    return {id, body: r.body, updatedAt: r.updated_at, lastEditedAt: r.editor ? r.updated_at : null,
      author: actor(r.user), editor: r.editor ? actor(r.editor) : null};
  }, api(path) {
    if (path === 'pulls/74') { reads++; change?.(s, reads); return structuredClone(s.pr); }
    if (path === 'commits/main') return {sha: s.main};
    if (path === 'issues/73') return structuredClone(s.issue);
    if (path === 'actions/variables/DOTSWEEPER_BOT_ID') return {value: '98765'};
    if (path === 'actions/variables/DOTLINK_AUTO_MERGE_ENABLED') return {value: policy.activationValue};
    if (path === 'actions/runs/456') return structuredClone(s.run);
    if (path.startsWith('actions/workflows/ci.yml/runs')) return {workflow_runs: structuredClone(s.ciRuns || [s.ciRun])};
    if (path === 'branches/main/protection') return structuredClone(s.protection);
    if (path.startsWith('compare/')) return structuredClone(s.ancestry);
    throw new Error(`Unexpected API ${path}`);
  }, pages(path) {
    if (path.startsWith('issues/74/comments')) return structuredClone(s.comments);
    if (path.startsWith('issues/73/comments')) return [];
    if (path.startsWith('actions/runs/456/jobs')) return [{jobs: structuredClone(s.jobs)}];
    if (path.startsWith('actions/runs/789/jobs')) return [{jobs: structuredClone(s.ciJobs)}];
    if (path.startsWith('pulls/74/files')) return structuredClone(s.files);
    if (path.startsWith('pulls/74/reviews')) return structuredClone(s.reviews);
    if (path.startsWith('pulls/74/comments')) return [];
    throw new Error(`Unexpected pagination ${path}`);
  }, checks: () => structuredClone(s.checks), merge(number, body) {
    merges.push({number, body}); return {merged: true, sha: 'c'.repeat(40)};
  }};
}

test('complete current evidence permits a dry-run decision without writes', () => {
  const s = fixture(), client = clientFor(s);
  assert.deepEqual(evaluate(s).reasons, []);
  assert.equal(evaluate(collect(74, client)).eligible, true);
  assert.deepEqual(client.merges, []);
});
test('trust, freshness, exact CI, findings, unknown evidence and sensitive changes each fail closed', () => {
  const changes = [s => s.pr.user.id = 123, s => s.pr.head.repo.full_name = 'fork/repo',
    s => s.pr.base.ref = 'parent', s => s.files[0].filename = 'scripts/build.mjs',
    s => s.files[0].previous_filename = '.github/workflows/ci.yml', s => s.pr.changed_files++,
    s => s.ancestry.status = 'diverged', s => s.pr.mergeable = null, s => s.pr.draft = true,
    s => s.protection.enforce_admins.enabled = false, s => s.protection.required_status_checks.strict = false,
    s => s.protection.required_status_checks.checks[0].app_id = 1,
    s => s.ciJobs[0].conclusion = 'skipped', s => s.ciJobs.pop(), s => s.ciRun.head_sha = main,
    s => s.ciRun.head_branch = 'other', s => s.ciRun.conclusion = 'failure', s => s.jobs[2].conclusion = 'skipped',
    s => s.receipt.quality.findings = 1, s => s.receipt.quality = undefined,
    s => s.context.acceptance.status = 'stale', s => s.context.acceptance.digest = 'changed',
    s => s.receipt.quality.assessment.requirements = [], s => s.context.acceptance.record.product_decisions = ['Choose UX'],
    s => s.context.acceptance.record.evidence[0].result = 'unknown', s => s.files[0].filename = 'src/main.ts',
    s => s.feedback.push({id: 9, body: 'New concern'}), s => s.scope.digest = 'changed',
    s => s.reviews.push({user: {id: 1}, state: 'CHANGES_REQUESTED'})];
  for (const change of changes) {
    const s = fixture(); change(s); assert.equal(evaluate(s).eligible, false, change.toString());
  }
});
test('latest associated CI wins even when a previous run succeeded', () => {
  const s = fixture(); s.ciRuns = [s.ciRun, {...s.ciRun, id: 790, conclusion: 'failure'}];
  const client = clientFor(s), original = client.pages;
  client.pages = path => path.startsWith('actions/runs/790/jobs') ? [{jobs: [{name: 'test', status: 'completed', conclusion: 'failure'}]}] : original(path);
  assert.equal(collect(74, client).ciRun.id, 790);
  assert.equal(evaluate(collect(74, client)).eligible, false);
});
test('editing an authentic bot receipt or maintainer record as another writer cannot authorize merging', () => {
  for (const id of [42, 50]) {
    const s = fixture();
    s.comments.find(x => x.id === id).editor = {id: 123, login: 'other-writer', type: 'User'};
    const client = clientFor(s);
    if (id === 50) assert.throws(() => collect(74, client), /revision is not authenticated/);
    else assert.equal(evaluate(collect(74, client)).eligible, false);
    assert.equal(client.merges.length, 0);
  }
});
test('activation is separately required, including trusted workflow ref', () => {
  assert.doesNotThrow(() => assertActivation(env, policy.activationValue));
  for (const key of Object.keys(env)) assert.throws(() => assertActivation({...env, [key]: ''}, policy.activationValue));
  assert.throws(() => assertActivation(env, 'false'));
  const client = clientFor(fixture());
  assert.throws(() => mergeEligible(74, client, {})); assert.equal(client.merges.length, 0);
});
test('execution rechecks everything and uses an exact-head compare-and-swap', () => {
  const client = clientFor(fixture());
  assert.equal(mergeEligible(74, client, env).merged, true);
  assert.deepEqual(client.merges, [{number: 74, body: {sha: head, merge_method: 'squash'}}]);
  for (const change of [s => s.main = 'd'.repeat(40), s => s.issue.body = 'New scope',
    s => s.comments.push({id: 80, user: owner, body: 'Wait for UX decision'}),
    s => s.ciRun.conclusion = 'failure', s => s.pr.head.sha = 'd'.repeat(40)]) {
    const client = clientFor(fixture(), (s, reads) => {if (reads === 2) change(s);});
    assert.equal(mergeEligible(74, client, env).merged, false); assert.equal(client.merges.length, 0);
  }
});
test('protected paths cover unknown files, renames and version metadata exceptions', () => {
  assert.deepEqual(protectedChanges([{filename: 'package.json', status: 'modified'}], {'package.json': true}), []);
  for (const file of [{filename: 'new-tool.mjs'}, {filename: 'package.json', status: 'modified'},
    {filename: 'docs/guide.md', previous_filename: 'scripts/tool.mjs'}, {filename: 'tests/auto-merge.test.mjs'},
    {filename: 'app.json', status: 'added'}]) assert.equal(protectedChanges([file]).length, 1);
  assert.equal(deviceAffected([{filename: 'docs/guide.md', previous_filename: 'src/main.ts'}]), true);
  assert.equal(deviceAffected([{filename: 'assets/brand/orbit/mark.svg'}]), false);
  assert.equal(deviceAffected([{filename: 'assets/brand/orbit/DotLink.icns'}]), true);
  assert.equal(deviceAffected([{filename: 'assets/brand/future-unknown.svg'}]), true);
});

test('transient metadata change is re-read after a delay and merges only once', async () => {
  const client = clientFor(fixture(), (s, reads) => {if (reads === 2) s.pr.updated_at = 'changed';});
  const waits = [];
  const result = await mergeWithReassessment(74, client, env, async ms => waits.push(ms));
  assert.equal(result.merged, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(waits, [30_000]);
  assert.deepEqual(result.reassessments[0].changed_inputs, ['pr']);
  assert.deepEqual(client.merges, [{number: 74, body: {sha: head, merge_method: 'squash'}}]);
});

test('API object-key order alone cannot hold an otherwise unchanged PR', async () => {
  const reverseKeys = x => Array.isArray(x) ? x.map(reverseKeys)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).reverse().map(key => [key, reverseKeys(x[key])])) : x;
  const original = fixture(), reordered = reverseKeys(original);
  assert.notEqual(hash(original), hash(reordered)); // Reproduces the old comparison bug.
  assert.equal(snapshotHash(original), snapshotHash(reordered));
  const client = clientFor(fixture(), (s, reads) => {if (reads === 2) s.pr = reverseKeys(s.pr);});
  const result = await mergeWithReassessment(74, client, env, async () => assert.fail('Key order must not require a retry'));
  assert.equal(result.merged, true);
  assert.equal(result.attempts, 1);
  assert.equal(client.merges.length, 1);
});

test('snapshot normalization retains all values, array order and missing-field differences', () => {
  for (const [before, after] of [[{a: 1}, {a: 2}], [{a: 1}, {a: 1, b: null}],
    [{items: [{id: 1}, {id: 2}]}, {items: [{id: 2}, {id: 1}]}],
    [{nested: {state: 'success'}}, {nested: {state: 'failure'}}]]) {
    assert.notEqual(snapshotHash(before), snapshotHash(after));
  }
});

test('persistent snapshot churn stops after three attempts without merging', async () => {
  const client = clientFor(fixture(), (s, reads) => {s.pr.updated_at = String(reads);});
  const waits = [];
  const result = await mergeWithReassessment(74, client, env, async ms => waits.push(ms));
  assert.equal(result.merged, false);
  assert.equal(result.attempts, 3);
  assert.deepEqual(waits, [30_000, 60_000]);
  assert.equal(client.merges.length, 0);
});

test('multiple churning candidates share one 90-second run budget', async () => {
  const budget = {remainingMs: 90_000}, waits = [], results = [];
  for (let candidate = 0; candidate < 4; candidate++) {
    const client = clientFor(fixture(), (s, reads) => {s.pr.updated_at = String(reads);});
    results.push(await mergeWithReassessment(74, client, env, async ms => waits.push(ms), budget));
    assert.equal(client.merges.length, 0);
  }
  assert.deepEqual(waits, [30_000, 60_000]);
  assert.deepEqual(results.map(x => x.attempts), [3, 1, 1, 1]);
  assert.equal(budget.remainingMs, 0);
  for (const result of results.slice(1)) assert.match(result.reasons.join(' '), /Run-wide reassessment wait budget exhausted/);
});

test('reassessment rechecks scope, head, main, CI, protection and activation', async () => {
  for (const change of [s => s.issue.body = 'New scope', s => s.pr.head.sha = 'd'.repeat(40),
    s => s.main = 'd'.repeat(40), s => s.ciRun.conclusion = 'failure',
    s => s.protection.enforce_admins.enabled = false]) {
    const s = fixture(), client = clientFor(s, (s, reads) => {if (reads === 2) s.pr.updated_at = 'changed';});
    const waits = [];
    const result = await mergeWithReassessment(74, client, env, async ms => {waits.push(ms); change(s);});
    assert.equal(result.merged, false, change.toString());
    assert.equal(result.attempts, 2);
    assert.deepEqual(waits, [30_000]);
    assert.equal(client.merges.length, 0);
  }
  const client = clientFor(fixture(), (s, reads) => {if (reads === 2) s.pr.updated_at = 'changed';});
  const api = client.api;
  await assert.rejects(mergeWithReassessment(74, client, env, async () => {
    client.api = path => path === 'actions/variables/DOTLINK_AUTO_MERGE_ENABLED' ? {value: 'disabled'} : api(path);
  }), /not activated/);
  assert.equal(client.merges.length, 0);
});

test('ordinary blockers and ambiguous merge API failures are not retried', async () => {
  const s = fixture(); s.ciRun.conclusion = 'failure';
  const client = clientFor(s), waits = [];
  const wait = async ms => waits.push(ms);
  assert.equal((await mergeWithReassessment(74, client, env, wait)).merged, false);
  const failing = clientFor(fixture()); let calls = 0;
  failing.merge = () => {calls++; throw new Error('connection lost after request');};
  await assert.rejects(mergeWithReassessment(74, failing, env, wait), /connection lost/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('Grok selection and labeled holds participate in the final merge decision', () => {
  const s = fixture(); s.pr.labels = [{name: 'grok-review'}];
  assert.ok(evaluate(s).reasons.some(x => x.startsWith('Grok review hold:')));
  assert.equal(mergeEligible(74, clientFor(s), env).merged, false);
  s.pr.labels = []; s.grokSelection = {automatic: true, fixes: []};
  assert.ok(evaluate(s).reasons.some(x => x.includes('awaiting the grok-review label')));
  const t = fixture(), client = clientFor(t, (value, reads) => {
    if (reads === 2) value.pr.labels = [{name: 'grok-review'}];
  });
  assert.equal(mergeEligible(74, client, env).merged, false);
  assert.equal(client.merges.length, 0);
});

test('late P0/P1 classification blocks even before asynchronous labeling completes', () => {
  const s = fixture(), client = clientFor(s);
  client.graphql = () => ({data: {repository: {pullRequest: {headRefOid: s.pr.head.sha,
    closingIssuesReferences: {pageInfo: {hasNextPage: false}, nodes: [{number: 26,
      repository: {nameWithOwner: repository}, labels: {pageInfo: {hasNextPage: false}, nodes: [{name: 'bug'}, {name: 'P1'}]}}]}}}}});
  assert.equal(mergeEligible(74, client, env).merged, false);
  assert.equal(client.merges.length, 0);
});
