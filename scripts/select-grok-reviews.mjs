// Add-only repository labeling. Uses trusted default-branch code, never PR code.
import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {automaticSelection, selected, grok, closingIssues, closingIssuesQuery} from './grok-review.mjs';
const repository = 'YusukeIt0/dot-link';
export function selectPR(number, client, apply = false) {
  const pr = client.api(`pulls/${number}`);
  if (pr.state !== 'open' || selected(pr)) return {number, action: 'unchanged'};
  const fixes = closingIssues(client.graphql(closingIssuesQuery, number), pr.head.sha);
  if (!automaticSelection(pr, fixes)) return {number, action: 'not-selected'};
  if (!apply) return {number, action: 'would-label'};
  // A stale add can only hold a PR, never release one. Recheck to avoid needless holds.
  const current = client.api(`pulls/${number}`);
  if (current.state !== 'open' || current.head.sha !== pr.head.sha || selected(current)) return {number, action: 'changed-before-label'};
  const currentFixes = closingIssues(client.graphql(closingIssuesQuery, number), current.head.sha);
  if (!automaticSelection(current, currentFixes)) return {number, action: 'not-selected'};
  client.addLabel(number, grok.label);
  return {number, action: 'labeled'};
}
function main() {
  const [mode = '--dry-run', number] = process.argv.slice(2);
  if (!['--dry-run', '--apply'].includes(mode) || (number && !/^[1-9]\d{0,8}$/.test(number)) || process.argv.length > 4) throw new Error('Usage: select-grok-reviews.mjs [--dry-run|--apply] [PR-number]');
  if (mode === '--apply' && (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repository ||
      process.env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/grok-review-selection.yml@refs/heads/main`)) throw new Error('Label writes require the trusted main selection workflow.');
  const command = (args, options = {}) => JSON.parse(execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 8_000_000, ...options}));
  const client = {
    api: path => command(['api', `repos/${repository}/${path}`]),
    graphql: (query, n) => command(['api', 'graphql', '-f', `query=${query}`, '-F', `number=${n}`]),
    addLabel: (n, label) => command(['api', `repos/${repository}/issues/${n}/labels`, '--input', '-'], {input: JSON.stringify({labels: [label]})}),
  };
  const prs = number ? [Number(number)] : command(['api', `repos/${repository}/pulls?state=open&per_page=100`, '--paginate', '--slurp']).flat().map(x => x.number);
  if (prs.length > 200) throw new Error('Too many open PRs; dispatch a specific PR.');
  const results = prs.map(n => selectPR(n, client, mode === '--apply'));
  console.log(JSON.stringify(results, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Grok review selection\n\n' + (results.map(x => `- #${x.number}: ${x.action}`).join('\n') || 'No open PRs.') + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
