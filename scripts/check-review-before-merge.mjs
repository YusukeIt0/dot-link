import {checksFailureOutput} from './check-output.mjs';
import {collectCI, ciTarget, assertCI} from './ci-evidence.mjs';
// Read-only maintainer gate. Does not approve, merge, rerun, or change branch rules.
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash, reviewInput, scopeRevision, reviewDiscussion, authenticateComments, commentRevisionQuery} from './review-evidence.mjs';
import {collectPriorReviews} from './review-provenance.mjs';

const repository = 'YusukeIt0/dot-link';
export {latestReceipt} from './review-receipt.mjs';
import {latestReceipt, assertReviewRun} from './review-receipt.mjs';

export function fingerprintPR(pr, main, comments, base, scope, feedback) {
  return hash(reviewInput(pr, pr, main, comments, base, scope, feedback));
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
  assertReviewRun(receipt, run, jobs);
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
      const output = pendingAllowed ? checksFailureOutput(error) : undefined;
      if (output !== undefined) return JSON.parse(output);
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
  const pages = path => gh(['api', `repos/${repository}/${path}`, '--paginate', '--slurp']).flat();
  const priorReviews = collectPriorReviews(pr, comments, api, pages, readNode, botId);
  const scope = scopeRevision(comments, pr.head.sha, api, pages, priorReviews);
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
