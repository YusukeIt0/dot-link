// Trusted policy code. Review text is data and must never be executed.
import {hash, trustedUser, authenticateComments} from './review-evidence.mjs';

export const grok = Object.freeze({appId: 5365493, botId: 344214582, login: 'dotsweeper2nd[bot]', label: 'independent-review'});
export const reviewMarker = '<!-- dot-link-grok-review:v1 -->';
export const adjudicationMarker = '<!-- dot-link-grok-adjudication:v1 -->';
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const text = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 8000;
const labels = row => (row.labels || []).map(x => typeof x === 'string' ? x : x.name);
export const highPriorityBug = row => labels(row).includes('bug') && labels(row).some(x => ['P0', 'P1'].includes(x));
export function automaticSelection(pr, closingIssues) {
  // Explicit classification / closing relationships, never title terms or mere mentions.
  if (labels(pr).includes('enhancement')) return false;
  return highPriorityBug(pr) || closingIssues.some(issue => issue.repository?.nameWithOwner === 'YusukeIt0/dot-link' && highPriorityBug(issue));
}
export const selected = pr => labels(pr).includes(grok.label);
export const grokActor = user => user?.type === 'Bot' && user.id === grok.botId && user.login === grok.login;
export const reviewAuthor = row => grokActor(row.user) && row.performed_via_github_app?.id === grok.appId;
export function authenticateGrokComments(rows, readNode) {
  return authenticateComments(rows, readNode, undefined, row =>
    row.body?.startsWith(reviewMarker) && reviewAuthor(row) ||
    row.body?.startsWith(adjudicationMarker) && trustedUser(row.user));
}
export function parseRecord(body, marker) {
  if (typeof body !== 'string' || body.length > 65000 || !body.startsWith(marker)) throw new Error('Missing record marker.');
  const blocks = [...body.matchAll(/^```json\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) throw new Error('Exactly one JSON record is required.');
  return JSON.parse(blocks[0][1]);
}
export function validateReview(record) {
  if (record?.version !== 1 || !sha(record.head) || !text(record.reviewer) ||
      !Number.isFinite(record.duration_seconds) || record.duration_seconds < 0 ||
      !Array.isArray(record.read_scope) || !record.read_scope.length || record.read_scope.length > 200 || !record.read_scope.every(text) ||
      !Array.isArray(record.limitations) || record.limitations.length > 50 || !record.limitations.every(text) ||
      !Array.isArray(record.findings) || record.findings.length > 50) throw new Error('Invalid Grok review record.');
  const ids = new Set();
  for (const f of record.findings) {
    if (!text(f?.id) || ids.has(f.id) || !['high', 'medium', 'low'].includes(f.severity) ||
        !text(f.file) || !Number.isSafeInteger(f.line) || f.line < 0 || !text(f.reason)) throw new Error('Invalid or duplicate Grok finding.');
    ids.add(f.id);
  }
  return record;
}
export const reviewDigest = row => hash({id: row.id, body: row.body, updated_at: row.updated_at});
const latest = rows => [...rows].sort((a, b) => a.id - b.id).at(-1);
export function grokBlockers(pr, comments, required = selected(pr)) {
  if (!required) return [];
  const hold = reason => [`Grok review hold: ${reason}`];
  const row = latest(comments.filter(x => reviewAuthor(x) && x.body?.startsWith(reviewMarker)));
  if (!row) return hold('no authenticated review comment.');
  if (!row.revision_verified || !grokActor(row.revision_author)) return hold('review revision is not authenticated.');
  let review;
  try { review = validateReview(parseRecord(row.body, reviewMarker)); }
  catch { return hold('latest review is malformed.'); }
  if (review.head !== pr.head.sha) return hold('review does not cover the current head.');
  const adjudication = latest(comments.filter(x => trustedUser(x.user) && x.body?.startsWith(adjudicationMarker)));
  if (!adjudication?.revision_verified || !trustedUser(adjudication.revision_author)) return hold('no authenticated adjudication.');
  let record;
  try { record = parseRecord(adjudication.body, adjudicationMarker); }
  catch { return hold('latest adjudication is malformed.'); }
  if (record?.version !== 1 || record.head !== pr.head.sha || record.review_comment_id !== row.id ||
      record.review_digest !== reviewDigest(row) || record.status !== 'completed') return hold('adjudication is stale or incomplete.');
  if (!Array.isArray(record.findings) || record.findings.length !== review.findings.length) return hold('not every finding has a disposition.');
  const ids = new Set();
  for (const disposition of record.findings) {
    if (!review.findings.some(f => f.id === disposition?.id) || ids.has(disposition.id) ||
        !['fixed', 'rejected'].includes(disposition.disposition) || !text(disposition.evidence)) return hold('a finding is unresolved or lacks evidence.');
    ids.add(disposition.id);
  }
  if (!text(record.summary)) return hold('adjudication needs a summary, including for no findings.');
  return [];
}

export const closingIssuesQuery = `query($number:Int!) {
  repository(owner:"YusukeIt0",name:"dot-link") { pullRequest(number:$number) {
    headRefOid
    closingIssuesReferences(first:100) { pageInfo { hasNextPage } nodes {
      number repository { nameWithOwner } labels(first:100) { pageInfo { hasNextPage } nodes { name } }
    } }
  } }
}`;
export function closingIssues(result, head) {
  const pr = result?.data?.repository?.pullRequest, refs = pr?.closingIssuesReferences;
  if (result?.errors?.length || pr?.headRefOid !== head || !Array.isArray(refs?.nodes) || refs.pageInfo?.hasNextPage !== false ||
      refs.nodes.some(x => !Array.isArray(x.labels?.nodes) || x.labels.pageInfo?.hasNextPage !== false)) throw new Error('Cannot verify complete current bug-fix relationships.');
  return refs.nodes.map(x => ({...x, labels: x.labels.nodes}));
}
