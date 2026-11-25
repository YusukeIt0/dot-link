// Read-only draft for the implementing agent. Never asserts approval or posts it.
import {execFileSync} from 'node:child_process';
import {acceptanceMarker, scopeDigest} from './review-evidence.mjs';

// Without a scope issue, the PR itself (title, description and human discussion) is the agreed scope.
const [prNumber, issueNumber = prNumber] = process.argv.slice(2);
if (![3, 4].includes(process.argv.length) || ![prNumber, issueNumber].every(x => /^[1-9]\d{0,8}$/.test(x || ''))) {
  console.error('Usage: node scripts/prepare-acceptance.mjs <PR-number> [agreed-scope-issue]');
  process.exit(1);
}
const repository = 'YusukeIt0/dot-link';
const get = (path, paginate = false) => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${path}`,
  ...(paginate ? ['--paginate', '--slurp'] : [])], {encoding: 'utf8', maxBuffer: 8_000_000}));
const pr = get(`pulls/${prNumber}`), issue = get(`issues/${issueNumber}`);
const ownPR = issueNumber === prNumber;
if (pr.state !== 'open' || issue.state !== 'open' || (issue.pull_request && !ownPR)) {
  throw new Error('Use an open PR and either its open scope issue or the PR itself.');
}
const record = {version: 1, head: pr.head.sha, scope: {approved: false, issue: Number(issueNumber),
  digest: scopeDigest(issue, get(`issues/${issueNumber}/comments?per_page=100`, true).flat())},
  requirements: [{id: 'R1', expected: 'Replace with an already agreed observable requirement.'}],
  evidence: [], product_decisions: ['Replace with unresolved product choices, or [] only when none remain.']};
console.log(`${acceptanceMarker}\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``);
console.error('Draft only: the agent must map actual evidence and existing product authorization before publishing. Missing evidence is not a pass.');
if (ownPR) console.error('Scope is this PR: any later description edit or human comment other than this record makes it stale.');
