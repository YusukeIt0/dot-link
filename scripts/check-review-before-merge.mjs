// Read-only maintainer gate. Does not approve, merge, rerun, or change branch rules.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository = 'YusukeIt0/dot-link';
const marker = '<!-- dot-link-opus-review:v1 -->';

export function latestReceipt(comments, botId) {
  const row = comments.filter(x => String(x.user?.id) === String(botId) &&
    x.user?.login === 'dotsweeper[bot]' && x.user?.type === 'Bot' && x.body?.startsWith(marker)).at(-1);
  if (!row) throw new Error('No verified dotsweeper comment.');
  const match = row.body.match(/^<!-- dot-link-opus-review:v1 -->\n<!-- dot-link-review-owner:([1-9]\d*):([1-9]\d*) -->\n## dotsweeper review · Complete\n\n<!-- dot-link-review-input:head=([a-f0-9]{40});main=([a-f0-9]{40});input=([a-f0-9]{64}) -->/);
  if (!match) throw new Error('Latest review is incomplete, outdated, failed, or predates revision receipts.');
  return {runId: match[1], intakeAttempt: Number(match[2]), head: match[3], main: match[4], fingerprint: match[5], commentId: row.id};
}

export function fingerprintPR(pr, main, comments) {
  const discussion = comments.filter(row => row.user?.type !== 'Bot').map(row => ({
    id:row.id, author:row.user?.login, body:row.body, updated_at:row.updated_at,
  }));
  const data = {number:pr.number, title:pr.title, body:pr.body, author:pr.user.login,
    kind:'pull_request', main, head:pr.head.sha, discussion};
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export function assertReady({pr, main, comments, receipt, run, jobs, checks}) {
  if (pr.state !== 'open' || pr.draft || pr.base?.ref !== 'main') throw new Error('PR must be open, ready and target main.');
  if (pr.head?.sha !== receipt.head || main !== receipt.main) throw new Error('PR head or main changed since the published review.');
  if (fingerprintPR(pr, main, comments) !== receipt.fingerprint) throw new Error('PR description or discussion changed since review.');
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
  if (!checks.length || checks.some(x => x.bucket !== 'pass')) throw new Error('Required checks are missing, pending, or unsuccessful.');
  return pr.head.sha;
}

async function main() {
  const number = process.argv[2];
  if (!/^[1-9]\d{0,8}$/.test(number || '')) throw new Error('Usage: node scripts/check-review-before-merge.mjs <PR number>');
  const gh = (args, pendingAllowed = false) => {
    try { return JSON.parse(execFileSync('gh', args, {encoding:'utf8', maxBuffer:5_000_000})); }
    catch (error) {
      if (pendingAllowed && [1,8].includes(error.status) && error.stdout?.trim().startsWith('[')) return JSON.parse(error.stdout);
      throw error;
    }
  };
  const api = path => gh(['api', `repos/${repository}/${path}`]);
  const botId = api('actions/variables/DOTSWEEPER_BOT_ID').value;
  const readComments = () => gh(['api', `repos/${repository}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp']).flat();
  const receipt = latestReceipt(readComments(), botId);
  const run = api(`actions/runs/${receipt.runId}`);
  const jobs = gh(['api', `repos/${repository}/actions/runs/${receipt.runId}/jobs?filter=latest&per_page=100`, '--paginate', '--slurp']).flatMap(x => x.jobs);
  const checks = gh(['pr', 'checks', number, '--repo', repository, '--required', '--json', 'name,state,bucket'], true);
  const pr = api(`pulls/${number}`);
  const base = api('commits/main').sha;
  const comments = readComments();
  if (JSON.stringify(receipt) !== JSON.stringify(latestReceipt(comments, botId))) throw new Error('Review ownership changed during this check.');
  const head = assertReady({pr, main:base, comments, receipt, run, jobs, checks});
  console.log(`READY: PR #${number}, head ${head}, review run ${receipt.runId}.`);
  console.log(`Read findings before deciding to merge. Use --match-head-commit ${head} when merging; repeat this check after any change.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`NOT READY: ${error.message}`); process.exitCode = 1; });
}
