import {collectCI, ciTarget, assertCI} from './ci-evidence.mjs';
// Read-only maintainer gate. Does not approve, merge, rerun, or change branch rules.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scopeRevision, reviewDiscussion, authenticateComments, commentRevisionQuery} from './review-evidence.mjs';

const repository = 'YusukeIt0/dot-link';
const marker = '<!-- dot-link-opus-review:v1 -->';

export function latestReceipt(comments, botId) {
  const row = comments.filter(x => String(x.user?.id) === String(botId) &&
    x.user?.login === 'dotsweeper[bot]' && x.user?.type === 'Bot' && x.body?.startsWith(marker)).at(-1);
  if (!row) throw new Error('No verified dotsweeper comment.');
  if (!row.revision_verified || row.revision_author?.type !== 'Bot' ||
      row.revision_author.login !== 'dotsweeper[bot]' || String(row.revision_author.id) !== String(botId)) {
    throw new Error('Current review comment revision is not authenticated to dotsweeper.');
  }
  const match = row.body.match(/^<!-- dot-link-opus-review:v1 -->\n<!-- dot-link-review-owner:([1-9]\d*):([1-9]\d*) -->\n## dotsweeper review · Complete\n\n<!-- dot-link-review-input:head=([a-f0-9]{40});main=([a-f0-9]{40});input=([a-f0-9]{64}) -->/);
  if (!match) throw new Error('Latest review is incomplete, outdated, failed, or predates revision receipts.');
  const baseMatch = row.body.slice(match[0].length).match(/^\n\n<!-- dot-link-review-base:ref=([^;\s]+);sha=([a-f0-9]{40}) -->/);
  const base = baseMatch ? {ref: decodeURIComponent(baseMatch[1]), sha: baseMatch[2]} : undefined;
  const qualityMatch = row.body.slice(match[0].length + (baseMatch?.[0].length || 0)).match(/^\n\n<!-- dot-link-review-quality:([A-Za-z0-9_-]+) -->/);
  let quality;
  if (qualityMatch) {
    if (qualityMatch[1].length > 80_000) throw new Error('Oversized review quality receipt.');
    quality = JSON.parse(Buffer.from(qualityMatch[1], 'base64url').toString('utf8'));
  }
  return {base, quality, runId: match[1], intakeAttempt: Number(match[2]), head: match[3], main: match[4], fingerprint: match[5], commentId: row.id};
}

export function fingerprintPR(pr, main, comments, base, scope, feedback) {
  const discussion = comments.filter(row => row.user?.type !== 'Bot').map(row => ({
    id:row.id, author:row.user?.login, body:row.body, updated_at:row.updated_at,
  }));
  const data = {number:pr.number, title:pr.title, body:pr.body, author:pr.user.login,
    kind:'pull_request', main, head:pr.head.sha, discussion};
  if (pr.base?.ref !== 'main') data.base = base;
  if (scope) data.scope = scope;
  if (feedback?.length) data.reviewDiscussion = feedback;
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export function assertReady({pr, main, base, scope, feedback, expectedBase = 'main', comments, receipt, run, jobs, checks, ciRun, ciJobs, ciComparison, baseComparison}) {
  if (pr.state !== 'open' || pr.draft || pr.base?.ref !== expectedBase) throw new Error('PR must be open, ready and target the expected base.');
  if (expectedBase !== 'main' && (!base || base.ref !== expectedBase || !/^[a-f0-9]{40}$/.test(base.sha) ||
      receipt.base?.ref !== base.ref || receipt.base?.sha !== base.sha)) throw new Error('PR base changed or lacks a pinned review receipt.');
  if (expectedBase !== 'main' && (!['ahead', 'identical'].includes(baseComparison?.status) ||
      baseComparison?.merge_base_commit?.sha !== base.sha)) {
    throw new Error('Child head must include the current parent commit; update the child and rerun CI/review.');
  }
  if (expectedBase === 'main' && receipt.base) throw new Error('Child review receipt cannot certify a main merge.');
  if (pr.head?.sha !== receipt.head || main !== receipt.main) throw new Error('PR head or main changed since the published review.');
  if (fingerprintPR(pr, main, comments, base, scope, feedback) !== receipt.fingerprint) throw new Error('PR description, discussion, inline review or agreed scope changed since review.');
  if (pr.mergeable !== true || pr.mergeable_state !== 'clean') throw new Error('GitHub has not confirmed the PR is cleanly mergeable.');
  if (String(run.id) !== receipt.runId || run.path !== '.github/workflows/claude-review.yml' ||
      run.repository?.full_name !== repository || run.status !== 'completed' || run.conclusion !== 'success' ||
      run.run_attempt < receipt.intakeAttempt) throw new Error('The owning review workflow has not completed successfully.');
  for (const name of ['intake', 'review', 'report']) {
    const matches = jobs.filter(x => x.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      throw new Error(`Review job is not successfully complete: ${name}`);
    }
  }
  if ((expectedBase === 'main' && !checks.length) || checks.some(x => x.bucket !== 'pass')) throw new Error('Required checks are missing, pending, or unsuccessful.');
  assertCI(ciTarget(pr, base || {ref: 'main', sha: main}), ciRun, ciJobs, ciComparison);
  return pr.head.sha;
}

async function main() {
  const number = process.argv[2];
  const expectedBase = process.argv[3] === '--base' ? process.argv[4] : 'main';
  if (!/^[1-9]\d{0,8}$/.test(number || '') || !expectedBase ||
      (process.argv.length > 3 && (process.argv[3] !== '--base' || process.argv.length !== 5))) {
    throw new Error('Usage: node scripts/check-review-before-merge.mjs <PR number> [--base <expected branch>]');
  }
  const gh = (args, pendingAllowed = false) => {
    try { return JSON.parse(execFileSync('gh', args, {encoding:'utf8', maxBuffer:5_000_000})); }
    catch (error) {
      if (pendingAllowed && [1,8].includes(error.status) && error.stdout?.trim().startsWith('[')) return JSON.parse(error.stdout);
      if (pendingAllowed && expectedBase !== 'main' && error.status === 1 &&
          /no required checks reported/.test(String(error.stderr))) return [];
      throw error;
    }
  };
  const api = path => gh(['api', `repos/${repository}/${path}`]);
  const botId = api('actions/variables/DOTSWEEPER_BOT_ID').value;
  const readNode = id => gh(['api', 'graphql', '-f', `query=${commentRevisionQuery}`, '-F', `id=${id}`]).data.node;
  const readComments = () => authenticateComments(gh(['api', `repos/${repository}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp']).flat(), readNode, botId);
  const receipt = latestReceipt(readComments(), botId);
  const run = api(`actions/runs/${receipt.runId}`);
  const jobs = gh(['api', `repos/${repository}/actions/runs/${receipt.runId}/jobs?filter=latest&per_page=100`, '--paginate', '--slurp']).flatMap(x => x.jobs);
  const checks = gh(['pr', 'checks', number, '--repo', repository, '--required', '--json', 'name,state,bucket'], true);
  const pr = api(`pulls/${number}`);
  const mainSha = api('commits/main').sha;
  const base = expectedBase === 'main' ? undefined : {ref: expectedBase, sha: api(`commits/${encodeURIComponent(expectedBase)}`).sha};
  const baseComparison = expectedBase !== 'main' ? api(`compare/${base.sha}...${pr.head.sha}`) : undefined;
  const evidence = collectCI(pr, base || {ref: 'main', sha: mainSha}, api,
    path => gh(['api', `repos/${repository}/${path}`, '--paginate', '--slurp']));
  const ciRun = evidence.run, ciJobs = evidence.jobs, ciComparison = evidence.comparison;
  const comments = readComments();
  const scope = scopeRevision(comments, pr.head.sha, api, path => gh(['api', `repos/${repository}/${path}`, '--paginate', '--slurp']).flat());
  const feedback = reviewDiscussion(pr.number, path => gh(['api', `repos/${repository}/${path}`, '--paginate', '--slurp']).flat());
  if (JSON.stringify(receipt) !== JSON.stringify(latestReceipt(comments, botId))) throw new Error('Review ownership changed during this check.');
  const currentPR = api(`pulls/${number}`);
  if (currentPR.head.sha !== pr.head.sha || currentPR.base.ref !== pr.base.ref ||
      api('commits/main').sha !== mainSha ||
      api(`commits/${encodeURIComponent(expectedBase)}`).sha !== (base?.sha || mainSha)) throw new Error('PR head/base changed during verification.');
  const head = assertReady({pr, main:mainSha, base, scope, feedback, expectedBase, comments, receipt, run, jobs, checks, ciRun, ciJobs, ciComparison, baseComparison});
  console.log(`READY: PR #${number} targeting ${expectedBase}, head ${head}, review run ${receipt.runId}.`);
  console.log(`Read findings before deciding to merge. Use --match-head-commit ${head} when merging; repeat this check after any change.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`NOT READY: ${error.message}`); process.exitCode = 1; });
}
