import {collectCI} from './ci-evidence.mjs';
// Public evidence is data. This module never executes reviewed code or mutates GitHub.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

export const policy = JSON.parse(readFileSync(new URL('../config/development-policy.json', import.meta.url), 'utf8'));
export const acceptanceMarker = '<!-- dot-link-acceptance:v1 -->';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value, max) => Array.isArray(value) && value.length <= max;
export const versionFiles = new Set(['package.json', 'package-lock.json', 'app.json']);
// Exact shared brand assets consumed only by the website. The Mac .icns and
// unknown future brand assets are release/runtime content by default.
export const websiteOnlyAsset = path => ['assets/brand/orbit/mark.svg', 'assets/brand/orbit/mac-1024.png'].includes(path) ||
  ['assets/readme/', 'assets/film/'].some(root => path.startsWith(root));
const canonical = value => JSON.stringify(value, (key, val) => val && !Array.isArray(val) && typeof val === 'object'
  ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val);
export function versionOnly(path, before, after) {
  if (!versionFiles.has(path)) return false;
  try {
    const old = JSON.parse(before), next = JSON.parse(after);
    if (!/^\d+\.\d+\.\d+$/.test(old.version) || !/^\d+\.\d+\.\d+$/.test(next.version)) return false;
    delete old.version; delete next.version;
    if (path === 'package-lock.json') {
      if (!old.packages?.[''] || !next.packages?.['']) return false;
      delete old.packages[''].version; delete next.packages[''].version;
    }
    return canonical(old) === canonical(next);
  } catch { return false; }
}
export function readMetadata(api, path, ref) {
  if (!versionFiles.has(path) || !sha(ref)) throw new Error('Invalid metadata request.');
  const data = api(`contents/${path}?ref=${ref}`);
  if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.size > 1_000_000) throw new Error('Version metadata cannot be verified.');
  return Buffer.from(data.content, 'base64').toString('utf8');
}
export const trustedUser = user => user?.type === 'User' && policy.trustedMaintainers.some(
  row => row.id === user.id && row.login === user.login);
export const commentRevisionQuery = `query($id:ID!) { node(id:$id) { ... on IssueComment {
  id body updatedAt lastEditedAt
  author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
  editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
} } }`;
const actorIdentity = actor => actor && ({id: actor.databaseId, type: actor.__typename,
  login: actor.__typename === 'Bot' ? actor.login.replace(/\[bot\]$/, '') + '[bot]' : actor.login});
// REST's user field identifies the original author, even after another writer
// edits the comment. Compare the body across APIs and authenticate its last editor.
export function authenticateComments(rows, readNode, botId, additionalRelevant = () => false) {
  return rows.map(row => {
    const relevant = row.body?.startsWith(acceptanceMarker) && trustedUser(row.user) ||
      row.body?.startsWith('<!-- dot-link-opus-review:v1 -->') && row.user?.type === 'Bot' &&
      row.user.login === 'dotsweeper[bot]' && String(row.user.id) === String(botId);
    if (!relevant && !additionalRelevant(row)) return row;
    if (!row.node_id || typeof readNode !== 'function') return {...row, revision_verified: false};
    const node = readNode(row.node_id);
    const author = actorIdentity(node?.author), editor = actorIdentity(node?.editor);
    const same = node?.id === row.node_id && node.body === row.body && node.updatedAt === row.updated_at &&
      author?.id === row.user.id && author.login === row.user.login && author.type === row.user.type;
    const revision = node?.lastEditedAt === null ? author : editor;
    return {...row, revision_verified: !!(same && revision), revision_author: revision};
  });
}

export function scopeDigest(issue, comments) {
  return hash({number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    discussion: comments.filter(row => row.user?.type !== 'Bot').map(row => ({
      id: row.id, author: row.user?.login, body: row.body, updated_at: row.updated_at,
    }))});
}

export function scopeRevision(comments, head, api, paginate) {
  const acceptance = acceptanceFromComments(comments, head);
  if (acceptance.status !== 'ready') return undefined;
  const number = acceptance.record.scope.issue;
  return {number, digest: scopeDigest(api(`issues/${number}`), paginate(`issues/${number}/comments?per_page=100`))};
}

export function reviewDiscussion(number, paginate) {
  const reviews = paginate(`pulls/${number}/reviews?per_page=100`);
  const comments = paginate(`pulls/${number}/comments?per_page=100`);
  return [...reviews.map(x => ({kind: 'review', id: x.id, author: x.user?.login, state: x.state,
    body: x.body, commit: x.commit_id, updated_at: x.submitted_at})),
  ...comments.map(x => ({kind: 'inline', id: x.id, author: x.user?.login, body: x.body,
    commit: x.commit_id, path: x.path, line: x.line, updated_at: x.updated_at}))];
}

export function validateAcceptance(record) {
  if (!record || record.version !== 1 || !sha(record.head) || record.scope?.approved !== true ||
      !Number.isSafeInteger(record.scope.issue) || record.scope.issue < 1 ||
      !/^[a-f0-9]{64}$/.test(record.scope.digest || '') ||
      !list(record.requirements, 20) || record.requirements.length === 0 ||
      !list(record.evidence, 40) || !list(record.product_decisions, 10) ||
      record.product_decisions.some(x => !text(x))) throw new Error('Invalid acceptance record.');
  const ids = new Set();
  for (const requirement of record.requirements) {
    if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(requirement?.id || '') || ids.has(requirement.id) ||
        !text(requirement.expected)) throw new Error('Invalid or duplicate requirement.');
    ids.add(requirement.id);
  }
  for (const evidence of record.evidence) {
    if (!evidence || !['automated', 'static', 'runtime', 'device'].includes(evidence.kind) ||
        !['pass', 'fail', 'unknown'].includes(evidence.result) ||
        !list(evidence.requirements, 20) || evidence.requirements.length === 0 ||
        new Set(evidence.requirements).size !== evidence.requirements.length ||
        evidence.requirements.some(id => !ids.has(id)) || !text(evidence.reference) || !text(evidence.details)) {
      throw new Error('Invalid evidence entry.');
    }
    if (['runtime', 'device'].includes(evidence.kind) &&
        (!sha(evidence.commit) || !text(evidence.steps) || !text(evidence.observed))) {
      throw new Error('Runtime/device evidence needs source, operations and observations.');
    }
    if (evidence.kind === 'device' && !text(evidence.build, 300)) throw new Error('Device evidence needs an exact build.');
  }
  return record;
}

export function acceptanceFromComments(comments, head) {
  const row = comments.filter(x => trustedUser(x.user) && x.body?.startsWith(acceptanceMarker)).at(-1);
  if (!row) return {status: 'missing', reason: 'No acceptance record from a configured maintainer.'};
  const base = {comment_id: row.id, author: row.user.login};
  if (!row.revision_verified || !trustedUser(row.revision_author)) return {...base, status: 'invalid',
    reason: 'The current acceptance revision is not authenticated to a configured maintainer.'};
  try {
    if (Buffer.byteLength(row.body) > 60_000) throw new Error('Acceptance record is too large.');
    const match = row.body.match(/^<!-- dot-link-acceptance:v1 -->\s*```json\s*\n([\s\S]+)\n```\s*$/);
    if (!match) throw new Error('Acceptance record must contain one JSON block.');
    const record = validateAcceptance(JSON.parse(match[1]));
    if (record.head !== head) return {...base, status: 'stale', reason: 'Acceptance record belongs to another head.'};
    return {...base, status: 'ready', record, digest: hash(record)};
  } catch (error) {
    // Do not echo invalid input or arbitrary parser text back into a public report.
    return {...base, status: 'invalid', reason: 'Acceptance record is malformed; use the documented schema.'};
  }
}

export function relatedCandidates(issue, rows) {
  const words = value => new Set((value.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [])
    .filter(x => !['with', 'from', 'that', 'this', 'when', 'into', 'link', 'change', 'changes'].includes(x)));
  const terms = words(issue.title || '');
  const mentioned = new Set([...`${issue.body || ''}`.matchAll(/(?:^|\s)#([1-9]\d*)\b/g)].map(x => Number(x[1])));
  return rows.filter(x => x.number !== issue.number && !x.pull_request).map(row => ({row,
    score: (mentioned.has(row.number) ? 100 : 0) + [...words(row.title || '')].filter(x => terms.has(x)).length,
  })).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.row.number - a.row.number).slice(0, 8)
    .map(({row}) => ({number: row.number, title: row.title, state: row.state,
      body: (row.body || '').slice(0, 1800), url: `https://github.com/YusukeIt0/dot-link/issues/${row.number}`}));
}

export function gatherContext(snapshot, api, paginate) {
  const context = {version: 1, kind: snapshot.pr ? 'pull_request' : 'issue', fingerprint: snapshot.fingerprint, related: [], ci: [],
    limitations: ['Related-item discovery is bounded, not an exhaustive search. Device entries are attributed observations, not automated device proof.']};
  if (!snapshot.pr) {
    const rows = api('issues?state=all&per_page=100&sort=updated&direction=desc');
    if (!Array.isArray(rows)) throw new Error('Invalid related-issue response.');
    context.related = relatedCandidates(snapshot.issue, rows);
    return context;
  }
  context.acceptance = acceptanceFromComments(snapshot.rows, snapshot.pr.head.sha);
  if (context.acceptance.status === 'ready') {
    const record = context.acceptance.record;
    const issue = api(`issues/${record.scope.issue}`);
    const comments = paginate(`issues/${record.scope.issue}/comments?per_page=100`);
    const digest = scopeDigest(issue, comments);
    if (issue.pull_request || issue.state !== 'open' || digest !== record.scope.digest) {
      context.acceptance = {...context.acceptance, status: 'stale', reason: 'The agreed scope issue changed or is no longer open.'};
    }
    context.scope = {number: issue.number, title: issue.title, body: issue.body, digest,
      discussion: comments.filter(x => x.user?.type !== 'Bot').map(x => ({id: x.id,
        author: x.user?.login, body: x.body, updated_at: x.updated_at}))};
    // Reuse only an ancestor's observations with unchanged runtime. Do not ask
    // testers to repeat a device session merely for docs/tests/version metadata.
    for (const evidence of record.evidence.filter(x => ['runtime', 'device'].includes(x.kind))) {
      if (evidence.commit === record.head) continue;
      const comparison = api(`compare/${evidence.commit}...${record.head}`);
      const reusable = ['ahead', 'identical'].includes(comparison.status) &&
        comparison.merge_base_commit?.sha === evidence.commit && Array.isArray(comparison.files) &&
        comparison.files.length < 300 && comparison.files.every(f => f.status !== 'renamed' &&
          (['docs/', 'tests/', 'site/'].some(p => f.filename.startsWith(p)) || websiteOnlyAsset(f.filename) || f.filename === 'README.md' ||
          f.status === 'modified' && versionFiles.has(f.filename) && versionOnly(f.filename,
            readMetadata(api, f.filename, evidence.commit), readMetadata(api, f.filename, record.head))));
      if (!reusable) context.acceptance = {...context.acceptance, status: 'stale',
        reason: 'Runtime/device evidence does not cover the current code; verify applicability before reuse.'};
    }
  }
  const evidence = collectCI(snapshot.pr, snapshot.data?.base ||
    (snapshot.data?.main ? {ref: 'main', sha: snapshot.data.main} : snapshot.pr.base), api, paginate);
  context.ci = evidence.run ? [{id: evidence.run.id, attempt: evidence.run.run_attempt,
    head: evidence.target.head, base: evidence.target.base, base_ref: evidence.target.baseRef,
    event: evidence.run.event, status: evidence.run.status, conclusion: evidence.run.conclusion,
    url: `https://github.com/YusukeIt0/dot-link/actions/runs/${evidence.run.id}`}]: [];
  context.ci_selection = {status: evidence.status, reason: evidence.reason};
  return context;
}

export function validateAssessment(value, context, safe = value => value, {allowUnknownRequirements = false} = {}) {
  if (!value || !['aligned', 'needs-product-decision', 'unknown'].includes(value.scope) ||
      !['not-required', 'recorded', 'missing'].includes(value.device) || !list(value.requirements, 20) ||
      !list(value.gaps, 10) || !list(value.architecture, 3) || !list(value.related, 8)) throw new Error('Invalid assessment.');
  const known = new Set(context?.acceptance?.record?.requirements.map(x => x.id) || []);
  const seen = new Set();
  let unknownRequirement = false;
  const requirements = value.requirements.map(x => {
    if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(x?.id || '') || (!known.has(x.id) && !allowUnknownRequirements) ||
        seen.has(x.id) || !['covered', 'gap', 'unknown'].includes(x.status) || !text(x.reason)) {
      throw new Error('Invalid requirement assessment.');
    }
    seen.add(x.id);
    if (!known.has(x.id)) {
      unknownRequirement = true;
      return {id: x.id, status: 'gap', reason: `Evidence gap: this ID is not in a current acceptance record. ${safe(x.reason)}`};
    }
    return {id: x.id, status: x.status, reason: safe(x.reason)};
  });
  const gaps = value.gaps.map(x => {if (!text(x)) throw new Error('Invalid evidence gap.'); return safe(x);});
  const architecture = value.architecture.map(x => {
    if (!x || !text(x.file, 500) || !text(x.signal) || !text(x.trigger) || !text(x.impact) || !text(x.next_step)) {
      throw new Error('Architecture advice needs concrete evidence and a triggering change.');
    }
    return Object.fromEntries(['file', 'signal', 'trigger', 'impact', 'next_step'].map(k => [k, safe(x[k])]));
  });
  const candidates = new Set(context?.related?.map(x => x.number) || []);
  // Relationships are advisory: discard unsupported rows without losing findings.
  const related = value.related.filter(x => x && candidates.has(x.number) &&
    ['related', 'possible-duplicate', 'dependency', 'possibly-resolved'].includes(x.relationship) && text(x.reason))
    .map(x => ({number: x.number, relationship: x.relationship, reason: safe(x.reason)}));
  return {scope: unknownRequirement ? 'unknown' : value.scope, device: value.device, requirements, gaps, architecture, related};
}

export function acceptanceBlockers(acceptance, assessment) {
  if (acceptance?.status !== 'ready') return [acceptance?.reason || 'No current acceptance record.'];
  if (!assessment) return ['No independent acceptance assessment.'];
  const reasons = [];
  const {record} = acceptance;
  if (record.product_decisions.length || assessment.scope !== 'aligned') reasons.push('A product decision or scope assessment is unresolved.');
  if (assessment.gaps.length) reasons.push('Independent review identified verification gaps.');
  for (const requirement of record.requirements) {
    if (assessment.requirements.find(x => x.id === requirement.id)?.status !== 'covered') reasons.push(`Requirement ${requirement.id} is not covered.`);
    const evidence = record.evidence.filter(x => x.requirements.includes(requirement.id));
    if (!evidence.length || evidence.some(x => x.result !== 'pass')) reasons.push(`Requirement ${requirement.id} has missing, failed or unknown evidence.`);
  }
  if (assessment.device === 'missing' || (assessment.device === 'recorded' &&
      !record.evidence.some(x => x.kind === 'device' && x.result === 'pass'))) reasons.push('Required physical acceptance is incomplete.');
  return reasons;
}
