// Historical product evidence for a delivery review, not a new merge authority.
import {acceptanceMarker, acceptanceFromComments, authenticateComments, hash, trustedUser, validateAssessment, acceptanceBlockers} from './review-evidence.mjs';
import {latestReceipt, assertReviewRun} from './review-receipt.mjs';
import {reviewMarker, adjudicationMarker, reviewAuthor, grokBlockers, selected} from './grok-review.mjs';
import {endpointReader} from './review-endpoints.mjs';

const repository = 'YusukeIt0/dot-link';
const latest = rows => [...rows].sort((a, b) => a.id - b.id).at(-1);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const observation = e => hash(Object.fromEntries(
  ['kind', 'result', 'commit', 'build', 'steps', 'observed', 'details'].map(key => [key, e[key] ?? null])));
const observed = e => ['device', 'runtime'].includes(e.kind) && e.result === 'pass';
const comment = row => ({id: row.id, url: `https://github.com/${repository}/issues/${row.issue_url.split('/').at(-1)}#issuecomment-${row.id}`,
  updated_at: row.updated_at, body: row.body});

export function collectPriorReviews(pr, rows, api, paginate, readNode, botId) {
  const current = acceptanceFromComments(rows, pr.head.sha);
  if (current.status !== 'ready' || !current.record.prior_reviews?.length) return undefined;
  const endpoints = endpointReader(api);
  const entries = current.record.prior_reviews.map(number => {
    const base = {pr: number, url: `https://github.com/${repository}/pull/${number}`};
    const invalid = reason => ({...base, status: 'unavailable', reason});
    if (number === pr.number) return invalid('A PR cannot supply its own prior product review.');
    const source = api(`pulls/${number}`);
    if (source.number !== number || source.merged !== true || source.state !== 'closed' ||
        source.base?.ref !== 'main' || source.base.repo?.full_name !== repository ||
        source.head?.repo?.full_name !== repository || !sha(source.head?.sha) || !sha(source.merge_commit_sha)) {
      return invalid('Source must be a merged in-repository product PR targeting main.');
    }
    const raw = paginate(`issues/${number}/comments?per_page=100`);
    if (!Array.isArray(raw) || raw.length > 200 || raw.some(row => row.issue_url !== `https://api.github.com/repos/${repository}/issues/${number}`)) {
      return invalid('Source discussion is incomplete, oversized or belongs to another item.');
    }
    // Authenticate only the latest relevant revisions, never fall back to an
    // older passing record. Ordinary post-merge housekeeping is not evidence.
    const candidates = [
      latest(raw.filter(row => trustedUser(row.user) && row.body?.startsWith(acceptanceMarker))),
      latest(raw.filter(row => row.user?.type === 'Bot' && row.user.login === 'dotsweeper[bot]' &&
        String(row.user.id) === String(botId) && row.body?.startsWith('<!-- dot-link-opus-review:v1 -->'))),
      ...(selected(source) ? [
        latest(raw.filter(row => reviewAuthor(row) && row.body?.startsWith(reviewMarker))),
        latest(raw.filter(row => trustedUser(row.user) && row.body?.startsWith(adjudicationMarker))),
      ] : []),
    ].filter(Boolean);
    const comments = authenticateComments(candidates, readNode, botId, row =>
      row.body?.startsWith(reviewMarker) && reviewAuthor(row) ||
      row.body?.startsWith(adjudicationMarker) && trustedUser(row.user));
    const acceptance = acceptanceFromComments(comments, source.head.sha);
    if (acceptance.status !== 'ready') return invalid('Latest source acceptance is missing, stale or unauthenticated.');
    if (acceptance.record.prior_reviews?.length) return invalid('Prior delivery reviews cannot form evidence-reuse chains.');
    let receipt;
    try { receipt = latestReceipt(comments, botId); }
    catch { return invalid('Latest source review is incomplete or unauthenticated.'); }
    const quality = receipt.quality;
    if (receipt.head !== source.head.sha || receipt.base || quality?.version !== 1 || quality.findings !== 0 ||
        quality.acceptance?.comment_id !== acceptance.comment_id || quality.acceptance.digest !== acceptance.digest ||
        quality.acceptance.scope_digest !== acceptance.record.scope.digest) {
      return invalid('Source review does not certify the latest source head and acceptance revision.');
    }
    try {
      const assessment = validateAssessment(quality.assessment, {acceptance});
      if (acceptanceBlockers(acceptance, assessment).length) return invalid('Source review has unresolved requirements or decisions.');
    } catch { return invalid('Source review assessment is invalid.'); }
    const run = api(`actions/runs/${receipt.runId}`);
    const jobs = paginate(`actions/runs/${receipt.runId}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs);
    try { assertReviewRun(receipt, run, jobs); }
    catch { return invalid('Source review workflow and all owning jobs must still be successful.'); }
    if (grokBlockers(source, comments).length) return invalid('Source independent review/adjudication is missing, stale or unresolved.');

    const merge = endpoints.compare(source.head.sha, source.merge_commit_sha);
    if (!merge.complete || merge.source_tree !== merge.target_tree) {
      return invalid('Merged source tree differs from the reviewed product head.');
    }
    const ancestry = api(`compare/${source.merge_commit_sha}...${pr.head.sha}`);
    const delivery = endpoints.compare(source.merge_commit_sha, pr.head.sha);
    if (!['ahead', 'identical'].includes(ancestry.status) || ancestry.merge_base_commit?.sha !== source.merge_commit_sha ||
        !delivery.complete || !delivery.files.every(f => f.filename === 'updates/mac/appcast.xml' &&
          f.status === 'modified' && f.before_mode === '100644' && f.after_mode === '100644')) {
      return invalid('Current head is not an unchanged product tree plus a bounded feed-only delivery delta.');
    }
    const sourceObservations = acceptance.record.evidence.filter(observed);
    const matches = current.record.evidence.filter(observed).filter(e => sourceObservations.some(old => observation(old) === observation(e)));
    if (!matches.length) return invalid('No unchanged observation matches the original source, build, operations, result and assumptions.');
    const comparisons = [...new Set(matches.map(e => e.commit))].map(commit => endpoints.compare(commit, source.head.sha));
    if (comparisons.some(c => !c.complete)) return invalid('Observation-to-product endpoint comparison is incomplete.');
    const sourceReview = comments.find(row => row.id === receipt.commentId);
    const sourceAcceptance = comments.find(row => row.id === acceptance.comment_id);
    const independent = selected(source) ? {
      review: comment(latest(comments.filter(row => reviewAuthor(row) && row.body?.startsWith(reviewMarker)))),
      adjudication: comment(latest(comments.filter(row => trustedUser(row.user) && row.body?.startsWith(adjudicationMarker)))),
    } : undefined;
    const entry = {...base, status: 'verified', source_head: source.head.sha, merge_commit: source.merge_commit_sha,
      source_tree: merge.source_tree, merge_tree: merge.target_tree,
      acceptance: {comment_id: sourceAcceptance.id, updated_at: sourceAcceptance.updated_at,
        digest: acceptance.digest, record: acceptance.record},
      review: {...comment(sourceReview), run_id: receipt.runId, run_attempt: run.run_attempt,
        automatic_acceptance_status: quality.acceptance.status},
      ...(independent ? {independent} : {}),
      observation_comparisons: comparisons, delivery_comparison: delivery,
      matched_observations: matches.map(e => ({commit: e.commit, build: e.build, kind: e.kind, digest: observation(e)})),
      limits: 'Authenticated historical product acceptance, not a current-stage approval. Preserve source/build and applicability assumptions. Beta observations do not prove official archive installation, changed environments or diagnostics. Current CI, release/archive/feed verification and post-merge normal-update checks remain separate. Automatic reuse eligibility is unchanged.'};
    if (Buffer.byteLength(JSON.stringify(entry)) > 40_000) return invalid('Prior product evidence exceeds the bounded context size.');
    return entry;
  });
  if (Buffer.byteLength(JSON.stringify(entries)) > 50_000) {
    const unavailable = entries.map(({pr, url}) => ({pr, url, status: 'unavailable',
      reason: 'Combined prior review context exceeds 50,000 bytes; reduce the referenced evidence scope.'}));
    return {entries: unavailable, digest: hash(unavailable)};
  }
  return {entries, digest: hash(entries)};
}
