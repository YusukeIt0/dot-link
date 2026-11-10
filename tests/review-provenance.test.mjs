import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPriorReviews} from '../scripts/review-provenance.mjs';
import {acceptanceMarker, policy, hash, scopeDigest, scopeRevision, gatherContext, validateAcceptance, acceptanceBlockers} from '../scripts/review-evidence.mjs';
import {grok, reviewMarker, adjudicationMarker, reviewDigest} from '../scripts/grok-review.mjs';
import {fingerprintPR} from '../scripts/check-review-before-merge.mjs';

const repository = 'YusukeIt0/dot-link';
const observed = 'a'.repeat(40), product = 'b'.repeat(40), merge = 'c'.repeat(40), head = 'd'.repeat(40);
const oldTree = '1'.repeat(40), productTree = '2'.repeat(40), deliveryTree = '3'.repeat(40);
const owner = {...policy.trustedMaintainers[0], type: 'User'};
const bot = {id: 1234, login: 'dotsweeper[bot]', type: 'Bot'};
const issue = {number: 322, title: 'Restore the managed app', body: 'Agreed behavior', state: 'open'};
const assessment = {scope: 'aligned', device: 'recorded', requirements: [{id: 'R1', status: 'covered', reason: 'Canonical device evidence applies'}], gaps: [], architecture: [], related: []};
const device = () => ({kind: 'device', result: 'pass', requirements: ['R1'], reference: 'Original physical observation',
  commit: observed, build: '0.4.37 (117) Beta; diagnostics off; macOS 27.2', steps: 'Restore, pause, resume',
  observed: 'One GUI, pause preserved, relay reconnects', details: 'Canonical paths equal realpath; no links on the test device.'});
const record = commit => ({version: 1, head: commit, scope: {approved: true, issue: 322, digest: scopeDigest(issue, [])},
  requirements: [{id: 'R1', expected: 'Restore without losing pause intent'}], evidence: [device()], product_decisions: []});
const row = (id, body, user = owner, number = 323) => ({id, node_id: `node${id}`, user: {...user}, body,
  issue_url: `https://api.github.com/repos/${repository}/issues/${number}`, updated_at: '2026-11-10T13:00:00Z'});
const acceptanceBody = r => `${acceptanceMarker}\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\``;
const file = (path, changed = false) => ({path, sha: (changed ? 'f' : 'e').repeat(40), type: 'blob', mode: '100644'});

function fixture() {
  const pr = {number: 325, head: {sha: head}, base: {ref: 'main', sha: merge}, user: owner};
  const original = record(product), current = {...record(head), prior_reviews: [323]};
  current.evidence[0].reference = 'PR323 observation reused for delivery';
  const currentRow = row(90, acceptanceBody(current), owner, 325);
  const rows = [{...currentRow, revision_verified: true, revision_author: owner}];
  const quality = {version: 1, findings: 0, assessment,
    acceptance: {status: 'stale', comment_id: 42, digest: hash(original), scope_digest: original.scope.digest}};
  const reviewBody = `<!-- dot-link-opus-review:v1 -->\n<!-- dot-link-review-owner:123:1 -->\n## dotsweeper review · Complete\n\n<!-- dot-link-review-input:head=${product};main=${'0'.repeat(40)};input=${'0'.repeat(64)} -->\n\n<!-- dot-link-review-quality:${Buffer.from(JSON.stringify(quality)).toString('base64url')} -->\n\nReviewed the actual five-file delta. Canonical paths still reach the same restore/pause/Resume behavior.`;
  const grokRecord = {version: 1, head: product, reviewer: 'Grok', duration_seconds: 30, read_scope: ['Product diff'], limitations: ['Static only'], findings: []};
  const independent = {...row(44, `${reviewMarker}\n\`\`\`json\n${JSON.stringify(grokRecord)}\n\`\`\``,
    {id: grok.botId, login: grok.login, type: 'Bot'}), performed_via_github_app: {id: grok.appId}};
  const adjudication = {version: 1, head: product, review_comment_id: 44, review_digest: reviewDigest(independent),
    status: 'completed', findings: [], summary: 'Earlier unique findings fixed; final review has no findings.'};
  const sourceRows = [row(42, acceptanceBody(original)), row(43, reviewBody, bot), independent,
    row(45, `${adjudicationMarker}\n\`\`\`json\n${JSON.stringify(adjudication)}\n\`\`\``)];
  const source = {number: 323, merged: true, state: 'closed', head: {sha: product, repo: {full_name: repository}},
    base: {ref: 'main', repo: {full_name: repository}}, merge_commit_sha: merge, labels: [{name: grok.label}]};
  const changed = ['scripts/lib/menu-install.mjs', 'scripts/lib/app-lifecycle.mjs', 'tests/install.test.mjs', 'tests/lifecycle.test.mjs', 'tests/location.test.mjs'];
  const unchanged = ['scripts/lib/app-location.mjs', 'scripts/mac-setup.mjs', 'scripts/lib/update-storage.mjs', 'native/DotLinkSetup/main.swift'];
  const trees = {
    [oldTree]: [...changed.map(p => file(p)), ...unchanged.map(p => file(p)), file('updates/mac/appcast.xml')],
    [productTree]: [...changed.map(p => file(p, true)), ...unchanged.map(p => file(p)), file('updates/mac/appcast.xml')],
    [deliveryTree]: [...changed.map(p => file(p, true)), ...unchanged.map(p => file(p)), file('updates/mac/appcast.xml', true)],
  };
  const run = {id: 123, path: '.github/workflows/claude-review.yml', repository: {full_name: repository},
    status: 'completed', conclusion: 'success', run_attempt: 1};
  const jobs = ['intake', 'review', 'report'].map(name => ({name, status: 'completed', conclusion: 'success'}));
  const responses = {
    'pulls/323': source, 'actions/runs/123': run, 'issues/322': issue,
    [`compare/${merge}...${head}`]: {status: 'ahead', merge_base_commit: {sha: merge}},
    // Deliberately wrong for endpoint content: GitHub's divergent merge-base list.
    [`compare/${observed}...${head}`]: {status: 'diverged', merge_base_commit: {sha: '0'.repeat(40)},
      files: unchanged.map(filename => ({filename, status: 'modified'}))},
    ...Object.fromEntries([[observed, oldTree], [product, productTree], [merge, productTree], [head, deliveryTree]]
      .map(([commit, tree]) => [`git/commits/${commit}`, {sha: commit, tree: {sha: tree}}])),
    ...Object.entries(trees).map(([id, tree]) => [`git/trees/${id}?recursive=1`, {sha: id, tree, truncated: false}])
      .reduce((object, [key, value]) => ({...object, [key]: value}), {}),
  };
  const api = path => {
    if (path.startsWith('actions/workflows/')) return {workflow_runs: []};
    assert.ok(path in responses, `Unexpected API: ${path}`); return responses[path];
  };
  const pages = path => {
    if (path === 'issues/323/comments?per_page=100') return sourceRows;
    if (path === 'actions/runs/123/jobs?filter=latest&per_page=100') return [{jobs}];
    if (path === 'issues/322/comments?per_page=100') return [];
    throw Error(`Unexpected pages: ${path}`);
  };
  const readNode = id => {
    const r = sourceRows.find(x => x.node_id === id);
    return {id, body: r.body, updatedAt: r.updated_at, lastEditedAt: null,
      author: {databaseId: r.user.id, login: r.user.login.replace(/\[bot\]$/, ''), __typename: r.user.type}};
  };
  return {pr, original, current, rows, sourceRows, source, trees, changed, unchanged, responses, api, pages, readNode, run, jobs,
    collect() {return collectPriorReviews(pr, rows, api, pages, this.readNode, bot.id);}};
}

test('#323 to #325 supplies exact endpoint changes and authenticated product reasoning after squash', () => {
  const f = fixture(), prior = f.collect(), entry = prior.entries[0];
  assert.equal(entry.status, 'verified');
  assert.equal(entry.source_head, product);
  assert.equal(entry.source_tree, entry.merge_tree);
  assert.deepEqual(entry.observation_comparisons[0].files.map(x => x.filename), [...f.changed].sort());
  assert.deepEqual(entry.delivery_comparison.files.map(x => x.filename), ['updates/mac/appcast.xml']);
  assert.match(entry.review.body, /Canonical paths still reach/);
  assert.match(entry.independent.adjudication.body, /Earlier unique findings fixed/);
  assert.equal(entry.acceptance.record.evidence[0].commit, observed);
  assert.match(entry.acceptance.record.evidence[0].build, /Beta/);
  assert.equal(entry.review.automatic_acceptance_status, 'stale', 'historical conservative eligibility is not rewritten');
  const context = gatherContext({pr: f.pr, rows: f.rows, priorReviews: prior}, f.api, f.pages);
  const delta = context.evidence_comparisons[0];
  assert.equal(delta.ancestor, false);
  assert.equal(delta.eligible, false, 'automatic gate is not relaxed');
  assert.deepEqual(delta.changed_files.map(x => x.path), [...f.changed, 'updates/mac/appcast.xml'].sort());
  assert.ok(f.unchanged.every(path => !delta.changed_files.some(x => x.path === path)));
  assert.ok(acceptanceBlockers(context.acceptance, assessment).length);
});

test('reference revisions participate in the same fingerprint used by intake and merge gates', () => {
  const f = fixture();
  const fingerprint = () => fingerprintPR(f.pr, merge, f.rows, undefined,
    scopeRevision(f.rows, head, f.api, f.pages, f.collect()), []);
  const first = fingerprint();
  f.sourceRows[1].body += '\nAdditional applicability limitation.';
  assert.notEqual(fingerprint(), first, 'even an authenticated review prose edit invalidates consumption');
  const second = fingerprint();
  f.jobs[2].conclusion = 'failure';
  assert.notEqual(fingerprint(), second, 'lost owning-job success invalidates consumption');
});

test('untrusted/stale source evidence, incomplete reviews and unsafe provenance never certify reuse', () => {
  for (const mutate of [
    f => f.source.merged = false,
    f => f.source.base.repo.full_name = 'other/repo',
    f => f.source.head.sha = observed,
    f => f.sourceRows[0].body = acceptanceBody({...f.original, product_decisions: ['Unresolved']}),
    f => f.sourceRows.push(row(99, acceptanceMarker + '\nmalformed')),
    f => f.sourceRows[1].user.id = 999,
    f => f.sourceRows[1].body = f.sourceRows[1].body.replace('Complete', 'Reviewing'),
    f => f.sourceRows[1].body = f.sourceRows[1].body.replace(`head=${product}`, `head=${observed}`),
    f => f.sourceRows[3].body += '\n```json\n{}\n```',
    f => f.sourceRows[2].body += '\nEdited review without new adjudication.',
    f => f.run.path = '.github/workflows/other.yml',
    f => f.jobs[1].status = 'in_progress',
    f => f.responses[`git/commits/${merge}`].tree.sha = oldTree,
    f => f.responses[`git/trees/${deliveryTree}?recursive=1`].truncated = true,
    f => f.trees[deliveryTree].push(file('native/DotLinkSetup/diagnostics.swift')),
    f => f.trees[deliveryTree].at(-1).mode = '120000',
    f => f.responses[`compare/${merge}...${head}`].status = 'diverged',
    f => f.sourceRows[0].issue_url = `https://api.github.com/repos/${repository}/issues/1`,
    f => {const read = f.readNode; f.readNode = id => ({...read(id), lastEditedAt: 'now',
      editor: {databaseId: 99, login: 'other-writer', __typename: 'User'}});},
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(f.collect().entries[0].status, 'unavailable');
  }
});

test('changed build, environment, diagnostics, operations or observation assumptions are not relabeled', () => {
  for (const field of ['commit', 'build', 'steps', 'observed', 'details']) {
    const f = fixture();
    f.current.evidence[0][field] = field === 'commit' ? merge : `changed ${field}`;
    f.rows[0].body = acceptanceBody(f.current);
    assert.equal(f.collect().entries[0].status, 'unavailable', field);
  }
});

test('prior references are optional, bounded and cannot recursively import delivery evidence', () => {
  const f = fixture();
  assert.equal(collectPriorReviews(f.pr, [], () => {throw Error('must not read');}, f.pages, f.readNode, bot.id), undefined);
  for (const refs of [[], [323, 323], [1, 2, 3], ['323'], [-1]]) {
    assert.throws(() => validateAcceptance({...f.current, prior_reviews: refs}));
  }
  f.original.prior_reviews = [1];
  f.sourceRows[0].body = acceptanceBody(f.original);
  assert.match(f.collect().entries[0].reason, /chains/);
  f.sourceRows.length = 201;
  assert.equal(f.collect().entries[0].status, 'unavailable');
});
