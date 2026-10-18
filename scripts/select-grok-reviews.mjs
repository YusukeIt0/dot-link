// Add-only repository labeling. Uses trusted default-branch code, never PR code.
import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {trustedUser, authenticateComments, commentRevisionQuery} from './review-evidence.mjs';
import {automaticSelection, selected, grok, closingIssues, closingIssuesQuery} from './grok-review.mjs';
import {notifyGrokReview} from './notify-grok-review.mjs';
const repository = 'YusukeIt0/dot-link';
async function notifyAfterLabel(number, client, notify) {
  try {
    const labeled = client.api(`pulls/${number}`);
    if (labeled.state === 'open') await notify({repo: repository, pr: number, head_sha: labeled.head.sha});
  } catch {
    // Label assignment already succeeded. A wake-up lookup must not abort other selections.
    console.warn('::warning::Grok notification skipped: current head could not be read. Review hold retained; use manual recovery.');
  }
}
export async function selectPR(number, client, apply = false, notify = notifyGrokReview, headChanged = false) {
  const pr = client.api(`pulls/${number}`);
  if (pr.state !== 'open') return {number, action: 'unchanged'};
  if (selected(pr)) {
    if (!headChanged || !apply) return {number, action: 'unchanged'};
    await notify({repo: repository, pr: number, head_sha: pr.head.sha});
    return {number, action: 'notified-head-change'};
  }
  const fixes = closingIssues(client.graphql(closingIssuesQuery, number), pr.head.sha);
  if (!automaticSelection(pr, fixes)) return {number, action: 'not-selected'};
  if (!apply) return {number, action: 'would-label'};
  // A stale add can only hold a PR, never release one. Recheck to avoid needless holds.
  const current = client.api(`pulls/${number}`);
  if (current.state !== 'open' || current.head.sha !== pr.head.sha || selected(current)) return {number, action: 'changed-before-label'};
  const currentFixes = closingIssues(client.graphql(closingIssuesQuery, number), current.head.sha);
  if (!automaticSelection(current, currentFixes)) return {number, action: 'not-selected'};
  client.addLabel(number, grok.label);
  await notifyAfterLabel(number, client, notify);
  return {number, action: 'labeled'};
}
export const selectionCommand = '/dotlink review2nd';
export function authorizedCommand(row, readNode) {
  if (!trustedUser(row?.user) || row.body?.trim() !== selectionCommand) return false;
  const [verified] = authenticateComments([row], readNode, undefined, () => true);
  return verified.revision_verified && trustedUser(verified.revision_author);
}
export async function selectFromComment(id, client, apply = false, notify = notifyGrokReview) {
  const path = `issues/comments/${id}`, row = client.api(path);
  if (!authorizedCommand(row, client.readNode)) return {comment: id, action: 'ignored-command'};
  const match = row.issue_url?.match(/^https:\/\/api\.github\.com\/repos\/YusukeIt0\/dot-link\/issues\/([1-9]\d*)$/);
  if (!match) throw new Error('Command target cannot be verified.');
  const number = Number(match[1]), issue = client.api(`issues/${number}`);
  if (!issue.pull_request) return {number, action: 'not-a-pr'};
  const pr = client.api(`pulls/${number}`);
  if (pr.state !== 'open' || selected(pr)) return {number, action: 'unchanged'};
  if (!apply) return {number, action: 'would-label-command'};
  if (!authorizedCommand(client.api(path), client.readNode)) return {number, action: 'command-changed'};
  client.addLabel(number, grok.label);
  await notifyAfterLabel(number, client, notify);
  return {number, action: 'labeled-command'};
}
async function main() {
  const [mode = '--dry-run', target, value] = process.argv.slice(2);
  const commandMode = target === '--comment', number = commandMode ? value : target;
  if (!['--dry-run', '--apply'].includes(mode) || (number && (!(commandMode ? /^[1-9]\d{0,14}$/ : /^[1-9]\d{0,8}$/).test(number) || !Number.isSafeInteger(Number(number)))) || (commandMode && !number) || process.argv.length > (commandMode ? 5 : 4) || (!commandMode && value)) throw new Error('Usage: select-grok-reviews.mjs [--dry-run|--apply] [PR-number | --comment comment-id]');
  if (process.env.REVIEW_HEAD_CHANGED === 'true' && (!number || commandMode)) throw new Error('Current-head notification requires a PR number.');
  if (mode === '--apply' && (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repository ||
      process.env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/grok-review-selection.yml@refs/heads/main`)) throw new Error('Label writes require the trusted main selection workflow.');
  const command = (args, options = {}) => JSON.parse(execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 8_000_000, ...options}));
  const client = {
    api: path => command(['api', `repos/${repository}/${path}`]),
    readNode: id => command(['api', 'graphql', '-f', `query=${commentRevisionQuery}`, '-F', `id=${id}`]).data.node,
    graphql: (query, n) => command(['api', 'graphql', '-f', `query=${query}`, '-F', `number=${n}`]),
    addLabel: (n, label) => command(['api', `repos/${repository}/issues/${n}/labels`, '--input', '-'], {input: JSON.stringify({labels: [label]})}),
  };
  if (commandMode) { console.log(JSON.stringify(await selectFromComment(Number(number), client, mode === '--apply'))); return; }
  const prs = number ? [Number(number)] : command(['api', `repos/${repository}/pulls?state=open&per_page=100`, '--paginate', '--slurp']).flat().map(x => x.number);
  if (prs.length > 200) throw new Error('Too many open PRs; dispatch a specific PR.');
  const results = [];
  const headChanged = Boolean(number) && process.env.REVIEW_HEAD_CHANGED === 'true';
  for (const n of prs) results.push(await selectPR(n, client, mode === '--apply', notifyGrokReview, headChanged));
  console.log(JSON.stringify(results, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Grok review selection\n\n' + (results.map(x => `- #${x.number}: ${x.action}`).join('\n') || 'No open PRs.') + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
