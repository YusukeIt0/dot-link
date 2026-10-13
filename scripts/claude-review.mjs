import {validateTriage, planLabels} from './review-labels.mjs';
import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const repo = process.env.GITHUB_REPOSITORY;
if (repo !== 'YusukeIt0/dot-link') throw new Error('This workflow is restricted to public Dot Link');
const mode = process.argv[2];
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const number = String(process.env.ITEM_NUMBER || event.issue?.number || event.pull_request?.number || event.inputs?.item_number || '');
if (!/^[1-9]\d{0,8}$/.test(number)) throw new Error('Expected a positive issue or PR number');
const root = `repos/${repo}`;
const endpoint = `${root}/issues/${number}`;
const gh = args => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 3_000_000});
const get = path => JSON.parse(gh(['api', path]));
const send = (path, body, method = 'POST') => JSON.parse(execFileSync('gh', ['api', path, '-X', method, '--input', '-'], {
  input: JSON.stringify(body), encoding: 'utf8', maxBuffer: 3_000_000,
  env: {...process.env, GH_TOKEN: process.env.REVIEW_WRITE_TOKEN},
}) || 'null');
const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
const marker = '<!-- dot-link-opus-review:v1 -->';
const botId = process.env.REVIEW_BOT_ID || '';
if (['intake', 'report'].includes(mode) && (!/^[1-9]\d*$/.test(botId) || !process.env.REVIEW_WRITE_TOKEN)) {
  throw new Error('Configure the dotsweeper bot identity and publishing credential');
}
const owned = row => String(row.user?.id) === botId && row.user?.login === 'dotsweeper[bot]' && row.user?.type === 'Bot' && row.body?.startsWith(marker);
function comments() {
  const pages = JSON.parse(gh(['api', `${endpoint}/comments?per_page=100`, '--paginate', '--slurp']));
  return pages.flat();
}
class IneligibleItem extends Error {}
function snapshot() {
  const issue = get(endpoint);
  if (issue.state !== 'open' || issue.locked) throw new IneligibleItem('Item must be open and unlocked');
  const pr = issue.pull_request ? get(`${root}/pulls/${number}`) : null;
  if (pr && (pr.draft || pr.state !== 'open' || pr.base.ref !== 'main')) throw new IneligibleItem('PR must be ready and target main');
  const rows = comments();
  const discussion = rows.filter(row => row.user?.type !== 'Bot').map(row => ({
    id: row.id, author: row.user?.login, body: row.body, updated_at: row.updated_at,
  }));
  const main = get(`${root}/commits/main`).sha;
  const data = {number: issue.number, title: issue.title, body: issue.body,
    author: issue.user?.login, kind: pr ? 'pull_request' : 'issue',
    main, head: pr?.head.sha || '', discussion};
  const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return {issue, pr, rows, data, fingerprint};
}
function publish(rows, body) {
  const existing = rows.find(owned);
  const payload = {body: marker + '\n' + body};
  const response = existing ? send(`${root}/issues/comments/${existing.id}`, payload, 'PATCH') : send(`${endpoint}/comments`, payload);
  console.log(`Review status: ${response.html_url}`);
}
const runUrl = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const help = 'For another review, the author or a maintainer can comment `/dotlink review`.';
function authorized(s) {
  const name = process.env.GITHUB_EVENT_NAME;
  const actor = event.sender;
  if (actor?.type !== 'User') return false;
  if (name === 'issue_comment') {
    const live = get(`${root}/issues/comments/${event.comment.id}`);
    if (live.user?.id !== actor.id || live.body?.trim() !== '/dotlink review' || live.issue_url !== `https://api.github.com/${endpoint}`) return false;
    if (actor.id === s.issue.user.id) return true;
    const p = get(`${root}/collaborators/${encodeURIComponent(actor.login)}/permission`);
    return ['admin', 'maintain', 'write'].includes(p.permission);
  }
  if (name === 'workflow_dispatch') {
    const p = get(`${root}/collaborators/${encodeURIComponent(actor.login)}/permission`);
    return ['admin', 'maintain', 'write'].includes(p.permission);
  }
  return (name === 'issues' && event.action === 'opened') ||
    (name === 'pull_request_target' && ['opened', 'ready_for_review'].includes(event.action));
}
function boundedInput(s) {
  const input = JSON.stringify(s.data, null, 2);
  if (Buffer.byteLength(input) > 150_000) throw new Error('Discussion exceeds review input limit');
  let diff = '';
  if (s.pr) {
    diff = gh(['api', `${root}/pulls/${number}`, '-H', 'Accept: application/vnd.github.diff']);
    if (!diff.trim() || Buffer.byteLength(diff) > 250_000 || s.pr.changed_files > 50) throw new Error('Change exceeds review input limit or is empty');
  }
  return {input, diff};
}
const safeText = value => {
  if (typeof value !== 'string' || value.length > 12_000) throw new Error('Invalid review text');
  if (/sk-ant-|gh[pousr]_[A-Za-z0-9]{15}|github_pat_|-----BEGIN .*PRIVATE KEY/.test(value)) throw new Error('Credential-like output withheld');
  return value.replace(/@/g, '@\u200b').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
};
function render(s) {
  const raw = process.env.REVIEW_JSON || '';
  if (Buffer.byteLength(raw) > 40_000) throw new Error('Oversized result');
  const result = JSON.parse(raw);
  if (!Array.isArray(result.findings) || result.findings.length > 10) throw new Error('Invalid findings');
  const triage = validateTriage(result.triage, safeText);
  const files = s.pr ? new Set(get(`${root}/pulls/${number}/files?per_page=100`).map(row => row.filename)) : null;
  const blocks = result.findings.map(f => {
    if (!['high', 'medium', 'low'].includes(f.severity)) throw new Error('Invalid severity');
    if (s.pr && (!files.has(f.file) || !Number.isSafeInteger(f.line) || f.line < 1)) throw new Error('Invalid PR finding location');
    return `### ${f.severity}: ${safeText(f.title)}\n\n${safeText(f.file)}${f.line ? ':' + f.line : ''}\n\n${safeText(f.reason)}`;
  });
  const body = [
    '## dotsweeper review · Complete',
    `Reviewed ${s.data.kind === 'issue' ? 'main' : 'PR head'}: \`${(s.data.head || s.data.main).slice(0, 12)}\` · [Run](${runUrl})`,
    safeText(result.summary), ...blocks,
    ...(!s.pr ? [`### Classification proposal\n\n${triage.priority || 'No single priority'}: ${triage.priority_reason}\n\n${triage.labels.map(x => `- \`${x.name}\`: ${x.reason}`).join('\n')}`] : []),
    `### Next steps\n\n${safeText(result.next_steps)}`,
    `### Scope and limitations\n\n${safeText(result.limitations)}`,
    'Advisory static review; no tests or physical-device checks were run. Maintainers decide adoption and merging.', help,
  ].join('\n\n');
  return {body, triage};
}

if (mode === 'intake') {
  output('accepted', 'false');
  let s;
  try { s = snapshot(); } catch (error) {
    if (!(error instanceof IneligibleItem)) throw error;
    console.log('Item no longer eligible; no review started.'); process.exit(0);
  }
  if (!authorized(s)) { console.log('No authorized review request.'); process.exit(0); }
  output('number', number);
  output('fingerprint', s.fingerprint);
  output('main_sha', s.data.main);
  try { boundedInput(s); } catch {
    publish(s.rows, `## dotsweeper review · Needs a smaller scope\n\nThe discussion or diff is too large, or the change is empty. No assessment was completed. Please narrow the scope and request another review.\n\n${help}`);
    process.exit(0);
  }
  publish(s.rows, `## dotsweeper review · Reviewing\n\n[Follow this run](${runUrl}). The result will replace this comment.\n\n${help}`);
  output('accepted', 'true');
} else if (mode === 'prepare') {
  const s = snapshot();
  if (s.fingerprint !== process.env.REVIEW_FINGERPRINT || s.data.main !== process.env.REVIEW_MAIN_SHA) throw new Error('Input changed before review');
  const {input, diff} = boundedInput(s);
  mkdirSync('.review', {recursive: true});
  writeFileSync('.review/input.json', input);
  writeFileSync('.review/changes.diff', diff);
  // A second snapshot detects a push/edit racing with diff collection.
  if (snapshot().fingerprint !== s.fingerprint) throw new Error('Input changed during collection');
  console.log(`Prepared ${s.data.kind} #${number}`);
} else if (mode === 'report') {
  const s = snapshot();
  let body, triage;
  if (s.fingerprint !== process.env.REVIEW_FINGERPRINT) {
    body = `## dotsweeper review · Outdated\n\nThe item or main changed during review. Findings were not published.\n\n${help}`;
  } else if (process.env.REVIEW_OUTCOME !== 'success') {
    body = `## dotsweeper review · Failed\n\nNo completed assessment is available. A maintainer can inspect the [run](${runUrl}) for authentication, usage limits, or execution errors.\n\n${help}`;
  } else {
    try { ({body, triage} = render(s)); } catch {
      body = `## dotsweeper review · Failed\n\nThe result could not be validated and was withheld.\n\n[Run](${runUrl})\n\n${help}`;
    }
  }
  // Never overwrite a newer run's in-progress/result comment.
  const current = comments();
  if (!current.some(row => owned(row) && row.body.includes(`](${runUrl})`))) throw new Error('A newer run owns the review comment');
  if (triage && !s.pr) {
    // Recheck content/main and current labels just before mutation. The model
    // cannot choose API paths or write anything; only this allowlisted plan can.
    const fresh = snapshot();
    if (fresh.fingerprint !== s.fingerprint) throw new Error('Input changed before label publication');
    try {
      const events = JSON.parse(gh(['api', `${endpoint}/events?per_page=100`, '--paginate', '--slurp'])).flat();
      const plan = planLabels((fresh.issue.labels || []).map(x => x.name), events, triage, botId);
      if (plan.add.length) send(`${endpoint}/labels`, {labels: plan.add});
      for (const label of plan.remove) send(`${endpoint}/labels/${encodeURIComponent(label)}`, {}, 'DELETE');
      body += `\n\n### Label application\n\n${plan.status} Added: ${plan.add.join(', ') || 'none'}. Removed: ${plan.remove.join(', ') || 'none'}.`;
    } catch {
      body += '\n\n### Label application\n\nLabel synchronization failed or was partial. Review findings remain available; inspect the issue labels and rerun after resolving the publishing error.';
      process.exitCode = 1;
    }
  }
  publish(current, body);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n');
} else throw new Error('Usage: claude-review.mjs intake|prepare|report');
