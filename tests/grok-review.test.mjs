import test from 'node:test';
import assert from 'node:assert/strict';
import {grok, reviewMarker, adjudicationMarker, automaticSelection, authenticateGrokComments, grokBlockers, reviewDigest, closingIssues} from '../scripts/grok-review.mjs';
import {policy} from '../scripts/review-evidence.mjs';
import {selectPR, selectFromComment} from '../scripts/select-grok-reviews.mjs';
const head = 'b'.repeat(40), owner = {...policy.trustedMaintainers[0], type: 'User'};
const bot = {id: grok.botId, login: grok.login, type: 'Bot'};
const encode = (marker, record) => `${marker}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n`;
function fixture(findings = []) {
  const pr = {number: 90, state: 'open', labels: [{name: 'independent-review'}], head: {sha: head}};
  const review = {version: 1, head, reviewer: 'Grok Bot', duration_seconds: 50, read_scope: ['src/a.ts:1-90', 'Issue #26 problem definition'], findings, limitations: ['Static review; tests not executed.']};
  const row = {id: 100, node_id: 'N100', body: encode(reviewMarker, review), updated_at: '2026-10-18T06:00:00Z', user: bot,
    performed_via_github_app: {id: grok.appId}, revision_verified: true, revision_author: bot};
  const disposition = {version: 1, head, review_comment_id: row.id, review_digest: reviewDigest(row), status: 'completed', summary: 'Findings checked against source.',
    findings: findings.map(f => ({id: f.id, disposition: 'rejected', evidence: 'src/a.ts:20 checks this input before the call.'}))};
  const adjudication = {id: 101, node_id: 'N101', body: encode(adjudicationMarker, disposition), updated_at: row.updated_at, user: owner, revision_verified: true, revision_author: owner};
  return {pr, review, row, disposition, adjudication, comments: [row, adjudication]};
}
const bug = {number: 26, repository: {nameWithOwner: 'YusukeIt0/dot-link'}, labels: [{name: 'bug'}, {name: 'P1'}]};
test('selection uses explicit bug classifications and closing relations, not incidental text', () => {
  assert.equal(automaticSelection({title: 'P1 bug fix #26', body: 'Related #26'}, []), false);
  assert.equal(automaticSelection({}, [bug]), true);
  assert.equal(automaticSelection({}, [{...bug, labels: [{name: 'P0'}, {name: 'enhancement'}]}]), false);
  assert.equal(automaticSelection({labels: ['enhancement']}, [bug]), false);
  assert.equal(automaticSelection({labels: ['bug', 'P0']}, []), true);
  assert.equal(automaticSelection({}, [{...bug, repository: {nameWithOwner: 'other/repo'}}]), false);
});
test('manual P2 selection holds until both current-head review and adjudication exist', () => {
  const s = fixture(); s.pr.labels.push({name: 'P2'});
  assert.equal(grokBlockers(s.pr, []).length, 1);
  assert.equal(grokBlockers(s.pr, [s.row]).length, 1);
  assert.deepEqual(grokBlockers(s.pr, s.comments), []);
  assert.deepEqual(grokBlockers({...s.pr, labels: []}, []), []);
  assert.equal(grokBlockers({...s.pr, labels: []}, [], true).length, 1);
});
test('head change, review revision, spoofed identities and stale/malformed adjudication fail closed', () => {
  const cases = [s => s.pr.head.sha = 'c'.repeat(40), s => s.row.user = {...bot, id: 1},
    s => s.row.user = {...bot, type: 'User'}, s => s.row.performed_via_github_app.id++,
    s => s.row.revision_verified = false, s => s.row.revision_author = owner,
    s => s.row.body += '\nChanged review', s => s.row.updated_at = '2026-10-18T07:00:00Z',
    s => s.adjudication.user = {...owner, id: 1}, s => s.adjudication.revision_author = bot,
    s => s.adjudication.revision_verified = false, s => s.disposition.head = 'c'.repeat(40),
    s => s.disposition.review_comment_id++, s => s.disposition.review_digest = '0'.repeat(64),
    s => s.disposition.status = 'pending', s => s.disposition.summary = '',
    s => s.review.read_scope = [], s => s.review.duration_seconds = -1];
  for (const change of cases) {
    const s = fixture(); change(s);
    if (change.toString().includes('s.disposition.')) s.adjudication.body = encode(adjudicationMarker, s.disposition);
    if (change.toString().includes('s.review.')) s.row.body = encode(reviewMarker, s.review);
    assert.equal(grokBlockers(s.pr, s.comments).length, 1, String(change));
  }
  const s = fixture(); s.comments.push({...s.adjudication, id: 102, body: `${adjudicationMarker}\nmalformed`});
  assert.equal(grokBlockers(s.pr, s.comments).length, 1);
  const t = fixture(); t.comments.push({...t.row, id: 103, body: `${reviewMarker}\nmalformed`});
  assert.equal(grokBlockers(t.pr, t.comments).length, 1);
});
test('every finding needs its own resolved evidence-based disposition', () => {
  const s = fixture([{id: 'G1', severity: 'high', file: 'src/a.ts', line: 20, reason: 'Input may be invalid.'}]);
  assert.deepEqual(grokBlockers(s.pr, s.comments), []);
  for (const findings of [[], [{id: 'G2', disposition: 'rejected', evidence: 'Source'}],
    [{id: 'G1', disposition: 'unresolved', evidence: 'Unknown'}], [{id: 'G1', disposition: 'fixed', evidence: ''}]]) {
    s.disposition.findings = findings; s.adjudication.body = encode(adjudicationMarker, s.disposition);
    assert.equal(grokBlockers(s.pr, s.comments).length, 1);
  }
});
test('REST author does not confer authority on an untrusted GraphQL editor', () => {
  const s = fixture(), actor = u => ({__typename: u.type, login: u.login, databaseId: u.id});
  const readNode = id => { const r = s.comments.find(x => x.node_id === id); return {id, body: r.body, updatedAt: r.updated_at,
    lastEditedAt: r.updated_at, author: actor(r.user), editor: actor({...owner, id: 1})}; };
  const rows = authenticateGrokComments(s.comments, readNode);
  assert.equal(rows.every(x => x.revision_verified), true);
  assert.equal(grokBlockers(s.pr, rows).length, 1);
  const mismatch = authenticateGrokComments(s.comments, id => ({...readNode(id), body: 'concurrent edit'}));
  assert.equal(mismatch.every(x => x.revision_verified === false), true);
});
function graph(headValue = head, nodes = []) {
  return {data: {repository: {pullRequest: {headRefOid: headValue,
    closingIssuesReferences: {pageInfo: {hasNextPage: false}, nodes: nodes.map(x => ({...x, labels: {nodes: x.labels, pageInfo: {hasNextPage: false}}}))}}}}};
}
test('incomplete issue/label pagination and head races cannot prove non-selection', () => {
  assert.deepEqual(closingIssues(graph(), head), []);
  const g = graph(head, [bug]); g.data.repository.pullRequest.closingIssuesReferences.pageInfo.hasNextPage = true;
  assert.throws(() => closingIssues(g, head));
  const h = graph(head, [bug]); h.data.repository.pullRequest.closingIssuesReferences.nodes[0].labels.pageInfo.hasNextPage = true;
  assert.throws(() => closingIssues(h, head));
  assert.throws(() => closingIssues(graph('c'.repeat(40)), head));
  assert.throws(() => closingIssues({...graph(), errors: [{}]}, head));
});
test('labeler is add-only, honors manual labels and rechecks before mutation', async () => {
  const writes = [], notices = []; let reads = 0;
  const notify = async payload => {assert.equal(writes.length, 1); notices.push(payload);};
  // A trusted-main scan also labels child PRs without running their base workflow.
  const pr = {number: 90, state: 'open', base: {ref: 'parent'}, labels: [], head: {sha: head}};
  const client = {api: () => {reads++; return structuredClone(pr);}, graphql: () => graph(head, [bug]), addLabel: (...x) => writes.push(x)};
  assert.equal((await selectPR(90, client, false, notify)).action, 'would-label'); assert.deepEqual(writes, []);
  assert.equal((await selectPR(90, client, true, notify)).action, 'labeled'); assert.deepEqual(writes, [[90, 'independent-review']]);
  pr.labels = ['independent-review', 'P2']; assert.equal((await selectPR(90, client, true, notify)).action, 'unchanged'); assert.equal(writes.length, 1);
  pr.labels = []; reads = 0;
  client.api = () => {reads++; return {...pr, head: {sha: reads === 1 ? head : 'c'.repeat(40)}};};
  assert.equal((await selectPR(90, client, true, notify)).action, 'changed-before-label'); assert.equal(writes.length, 1);
  assert.deepEqual(notices, [{repo: 'YusukeIt0/dot-link', pr: 90, head_sha: head}]);
  client.api = () => structuredClone({...pr, head: {sha: head}});
  client.addLabel = () => {throw new Error('403');};
  await assert.rejects(selectPR(90, client, true, notify), /403/);
  assert.equal(notices.length, 1);
});

test('review2nd is maintainer-only, authenticates edits and selects lower-priority PRs', async () => {
  const notices = [], notify = async payload => {assert.equal(writes.length, 1); notices.push(payload);};
  const writes = [], row = {id: 6246408503, node_id: 'Ncmd', body: '/dotlink review2nd',
    updated_at: '2026-10-18T07:00:00Z', user: owner, issue_url: 'https://api.github.com/repos/YusukeIt0/dot-link/issues/90'};
  const actor = u => ({__typename: u.type, login: u.login, databaseId: u.id});
  const client = {api(path) {
    if (path === 'issues/comments/6246408503') return structuredClone(row);
    if (path === 'issues/90') return {pull_request: {}};
    if (path === 'pulls/90') return {state: 'open', labels: ['P2'], head: {sha: head}};
    throw new Error(path);
  }, readNode() {return {id: row.node_id, body: row.body, updatedAt: row.updated_at,
    lastEditedAt: row.editor ? row.updated_at : null, author: actor(row.user), editor: row.editor && actor(row.editor)};},
  addLabel: (...args) => writes.push(args)};
  assert.equal((await selectFromComment(row.id, client, false, notify)).action, 'would-label-command');
  assert.deepEqual(writes, []);
  assert.equal((await selectFromComment(row.id, client, true, notify)).action, 'labeled-command');
  assert.deepEqual(writes, [[90, 'independent-review']]);
  for (const user of [{...owner, id: 1}, {...owner, login: 'other'}, bot]) {
    row.user = user; assert.equal((await selectFromComment(row.id, client, true, notify)).action, 'ignored-command');
  }
  row.user = owner; row.editor = {...owner, id: 1};
  assert.equal((await selectFromComment(row.id, client, true, notify)).action, 'ignored-command');
  delete row.editor;
  for (const body of ['quoted /dotlink review2nd', '/dotlink review', '/dotlink review2nd\nextra']) {
    row.body = body; assert.equal((await selectFromComment(row.id, client, true, notify)).action, 'ignored-command');
  }
  row.body = '/dotlink review2nd'; let reads = 0; const api = client.api;
  client.api = path => {if (path === 'issues/comments/6246408503' && ++reads === 2) row.editor = bot; return api(path);};
  assert.equal((await selectFromComment(row.id, client, true, notify)).action, 'command-changed');
  assert.equal(writes.length, 1);
  assert.deepEqual(notices, [{repo: 'YusukeIt0/dot-link', pr: 90, head_sha: head}]);
});

test('a selected PR head update notifies once; unrelated event scans and dry runs stay silent', async () => {
  const notices = [], pr = {state: 'open', labels: ['independent-review'], head: {sha: 'c'.repeat(40)}};
  const client = {api: () => structuredClone(pr), addLabel: () => assert.fail('existing label must not be rewritten')};
  const notify = async data => notices.push(data);
  assert.equal((await selectPR(90, client, true, notify, true)).action, 'notified-head-change');
  assert.deepEqual(notices, [{repo: 'YusukeIt0/dot-link', pr: 90, head_sha: pr.head.sha}]);
  await selectPR(90, client, true, notify);
  await selectPR(90, client, false, notify, true);
  pr.state = 'closed'; await selectPR(90, client, true, notify, true);
  assert.equal(notices.length, 1);
});
