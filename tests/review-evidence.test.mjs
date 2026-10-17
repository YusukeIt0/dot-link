import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceMarker, policy, hash, scopeDigest, acceptanceFromComments, validateAcceptance,
  validateAssessment, acceptanceBlockers, gatherContext, relatedCandidates, versionOnly, trustedUser, authenticateComments} from '../scripts/review-evidence.mjs';

const head = 'b'.repeat(40), before = 'a'.repeat(40);
const owner = {...policy.trustedMaintainers[0], type: 'User'};
const issue = {number: 73, title: 'Improve state ownership', body: 'Agreed behavior', state: 'open'};
const record = () => ({version: 1, head, scope: {approved: true, issue: 73, digest: scopeDigest(issue, [])},
  requirements: [{id: 'R1', expected: 'State is preserved'}],
  evidence: [{kind: 'automated', result: 'pass', requirements: ['R1'], reference: 'test run', details: 'Persistence assertions pass'}], product_decisions: []});
const row = (value = record()) => ({id: 42, user: owner, revision_verified: true, revision_author: owner, body: `${acceptanceMarker}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``});
const assessment = () => ({scope: 'aligned', device: 'not-required', requirements: [{id: 'R1', status: 'covered', reason: 'Behavior tested'}], gaps: [], architecture: [], related: []});

test('acceptance authenticates numeric identity and rejects newest malformed/stale declarations', () => {
  assert.equal(acceptanceFromComments([row()], head).status, 'ready');
  for (const user of [{...owner, id: 1}, {...owner, login: 'impostor'}, {...owner, type: 'Bot'}]) {
    assert.equal(trustedUser(user), false);
    assert.equal(acceptanceFromComments([{...row(), user}], head).status, 'missing');
  }
  assert.equal(acceptanceFromComments([row(), {...row(), body: acceptanceMarker + '\ninvalid'}], head).status, 'invalid');
  assert.equal(acceptanceFromComments([row(), row({...record(), head: before})], head).status, 'stale');
});

test('scope changes invalidate the declaration while bot triage does not', () => {
  assert.notEqual(scopeDigest({...issue, body: 'New UX'}, []), scopeDigest(issue, []));
  assert.notEqual(scopeDigest(issue, [{id: 1, user: owner, body: 'New constraint'}]), scopeDigest(issue, []));
  assert.equal(scopeDigest(issue, [{id: 2, user: {type: 'Bot'}, body: 'Triage'}]), scopeDigest(issue, []));
});

test('latest editor and the exact cross-API body are authenticated, not just original authorship', () => {
  const r = {...row(), node_id: 'comment42', updated_at: '2026-10-17T20:00:00Z'};
  const actor = {__typename: 'User', login: owner.login, databaseId: owner.id};
  const node = {id: r.node_id, body: r.body, updatedAt: r.updated_at, lastEditedAt: null, author: actor, editor: null};
  const read = n => authenticateComments([r], () => n, 98765)[0];
  assert.equal(acceptanceFromComments([read(node)], head).status, 'ready');
  assert.equal(acceptanceFromComments([read({...node, lastEditedAt: r.updated_at, editor: actor})], head).status, 'ready');
  for (const n of [null, {...node, body: 'changed between API reads'}, {...node, updatedAt: 'new'},
    {...node, lastEditedAt: r.updated_at},
    {...node, lastEditedAt: r.updated_at, editor: {...actor, databaseId: 1, login: 'other-writer'}}]) {
    assert.equal(acceptanceFromComments([read(n)], head).status, 'invalid');
  }
  assert.equal(acceptanceFromComments(authenticateComments([r], undefined, 98765), head).status, 'invalid');
});

test('records require traceable evidence without pretending unknown/failed results passed', () => {
  for (const change of [r => r.scope.approved = false, r => r.requirements.push(r.requirements[0]),
    r => r.evidence[0].requirements = ['UNKNOWN'], r => r.evidence[0].kind = 'device', r => r.head = 'branch']) {
    const r = record(); change(r); assert.throws(() => validateAcceptance(r));
  }
  for (const change of [r => r.product_decisions.push('Choose behavior'), r => r.evidence = [],
    r => r.evidence[0].result = 'unknown', r => r.evidence[0].result = 'fail']) {
    const r = record(); change(r);
    assert.ok(acceptanceBlockers(acceptanceFromComments([row(r)], head), assessment()).length);
  }
  const acceptance = acceptanceFromComments([row()], head);
  assert.deepEqual(acceptanceBlockers(acceptance, assessment()), []);
  for (const change of [a => a.scope = 'unknown', a => a.device = 'missing', a => a.device = 'recorded',
    a => a.requirements = [], a => a.requirements[0].status = 'unknown', a => a.gaps.push('Unknown UX')]) {
    const a = assessment(); change(a); assert.ok(acceptanceBlockers(acceptance, a).length);
  }
});

test('review cannot invent requirements; concrete architecture advice is non-blocking', () => {
  const context = {acceptance: acceptanceFromComments([row()], head), related: [{number: 9}]};
  for (const change of [a => a.requirements[0].id = 'R2', a => a.requirements.push(a.requirements[0]),
    a => a.architecture.push({file: 'src/main.ts', signal: 'Long'})]) {
    const a = assessment(); change(a); assert.throws(() => validateAssessment(a, context));
  }
  const a = assessment(); a.architecture.push({file: 'src/state.ts', signal: 'Two callers write the same state',
    trigger: 'Adding a third state writer', impact: 'Order-dependent updates', next_step: 'Revisit ownership with that change'});
  assert.deepEqual(acceptanceBlockers(context.acceptance, validateAssessment(a, context)), []);
});

function contextFor(r, changes = {}) {
  const api = path => {
    if (path === 'issues/73') return changes.issue || issue;
    if (path.startsWith('compare/')) return changes.comparison;
    if (path.startsWith('actions/')) return {workflow_runs: []};
    throw new Error(`Unexpected API: ${path}`);
  };
  return gatherContext({pr: {head: {sha: head}}, rows: [row(r)], fingerprint: hash('snapshot')}, api, () => changes.comments || []);
}
test('evidence reuse requires ancestor code and a bounded non-runtime diff', () => {
  const r = record(); r.evidence.push({kind: 'device', result: 'pass', requirements: ['R1'],
    reference: 'Attributed observation', details: 'Tester saw state preserved', commit: before, build: '0.3.12 Beta',
    steps: 'Save and reopen', observed: 'Saved state appears'});
  const comparison = {status: 'ahead', merge_base_commit: {sha: before}, files: [{filename: 'docs/guide.md', status: 'modified'}]};
  assert.equal(contextFor(r, {comparison}).acceptance.status, 'ready');
  for (const change of [c => c.status = 'diverged', c => c.merge_base_commit.sha = head,
    c => c.files[0].filename = 'src/main.ts', c => c.files[0].filename = 'assets/brand/orbit/DotLink.icns',
    c => c.files[0].filename = 'assets/brand/future-unknown.svg', c => c.files[0].status = 'renamed',
    c => c.files = Array(300).fill(c.files[0])]) {
    const c = structuredClone(comparison); change(c); assert.equal(contextFor(r, {comparison: c}).acceptance.status, 'stale');
  }
  assert.equal(contextFor(record(), {issue: {...issue, state: 'closed'}}).acceptance.status, 'stale');
  assert.equal(contextFor(record(), {issue: {...issue, body: 'Edited'}}).acceptance.status, 'stale');
});

test('scope constraints in human comments reach the reviewer instead of only changing a digest', () => {
  const comments = [{id: 7, user: owner, body: 'Additional agreed constraint: never upload raw audio', updated_at: '2026-10-17'}];
  const r = record(); r.scope.digest = scopeDigest(issue, comments);
  const context = contextFor(r, {comments});
  assert.equal(context.acceptance.status, 'ready');
  assert.equal(context.scope.discussion[0].body, comments[0].body);
  assert.equal(context.scope.discussion[0].author, owner.login);
});

test('publisher can retain findings while flagging stale/unknown requirement IDs; merge validation stays strict', () => {
  const a = assessment();
  const context = {acceptance: {status: 'stale', reason: 'Wrong head'}, related: []};
  const published = validateAssessment(a, context, x => x, {allowUnknownRequirements: true});
  assert.equal(published.requirements[0].status, 'gap');
  assert.match(published.requirements[0].reason, /not in a current acceptance record/);
  assert.equal(published.scope, 'unknown');
  assert.throws(() => validateAssessment(published, context));
  assert.ok(acceptanceBlockers(context.acceptance, published).length);
});

test('version-only exception does not allow dependency, script, or permission changes', () => {
  const first = JSON.stringify({version: '0.3.12', scripts: {test: 'node --test'}});
  assert.equal(versionOnly('package.json', first, JSON.stringify({scripts: {test: 'node --test'}, version: '0.3.13'})), true);
  assert.equal(versionOnly('package.json', first, JSON.stringify({version: '0.3.13', scripts: {test: 'true'}})), false);
  assert.equal(versionOnly('app.json', '{"version":"0.3.12","permissions":[]}', '{"version":"0.3.13","permissions":["microphone"]}'), false);
  assert.equal(versionOnly('package.json', first, 'invalid'), false);
});

test('related discovery is bounded, excludes self/PRs and prioritizes explicit links', () => {
  const rows = Array.from({length: 15}, (_, i) => ({number: i + 1, title: 'State ownership', body: 'x'.repeat(2000), state: 'open'}));
  rows.push({number: 73, title: issue.title}, {number: 90, title: issue.title, pull_request: {}});
  const found = relatedCandidates({...issue, body: 'See #1'}, rows);
  assert.equal(found.length, 8); assert.equal(found[0].number, 1);
  assert.ok(found.every(x => x.body.length <= 1800 && x.number !== 73 && x.number !== 90));
});

test('unsupported advisory relationships are omitted while supported evidence stays intact', () => {
  const a = assessment();
  a.related = [null, {number: 99, relationship: 'dependency', reason: 'Invented'},
    {number: 9, relationship: 'dependency', reason: 'Verified candidate'},
    {number: 9, relationship: 'invalid', reason: 'Unsupported'}];
  const checked = validateAssessment(a, {acceptance: acceptanceFromComments([row()], head), related: [{number: 9}]});
  assert.deepEqual(checked.related, [a.related[2]]);
  assert.deepEqual(checked.requirements, a.requirements);
});
