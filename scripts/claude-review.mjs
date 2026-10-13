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
if (!/^[1-9]\d*$/.test(botId)) throw new Error('Configure the dotsweeper bot identity for every review stage');
if (['intake', 'report'].includes(mode) && !process.env.REVIEW_WRITE_TOKEN) {
  throw new Error('Configure the dotsweeper bot identity and publishing credential');
}
const owned = row => String(row.user?.id) === botId && row.user?.login === 'dotsweeper[bot]' && row.user?.type === 'Bot' && row.body?.startsWith(marker);
function comments() {
  const pages = JSON.parse(gh(['api', `${endpoint}/comments?per_page=100`, '--paginate', '--slurp']));
  return pages.flat();
}
function snapshot() {
  const issue = get(endpoint);
  const pr = issue.pull_request ? get(`${root}/pulls/${number}`) : null;
  const reason = issue.locked ? 'The item is locked.'
    : issue.state !== 'open' ? (pr?.merged ? 'The PR was merged.' : 'The item was closed.')
    : pr?.draft ? 'The PR was converted to draft.'
    : pr && (pr.state !== 'open' || pr.base.ref !== 'main') ? 'The PR is no longer open against main.' : '';
  const rows = comments();
  if (reason) return {issue, pr, rows, reason};
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
  const payload = {body: marker + '\n' + ownershipMarker + '\n' + body};
  const response = existing ? send(`${root}/issues/comments/${existing.id}`, payload, 'PATCH') : send(`${endpoint}/comments`, payload);
  console.log(`Review status: ${response.html_url}`);
}
const runUrl = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const owner = mode === 'intake' ? `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT || '1'}` : process.env.REVIEW_OWNER;
if (!/^[1-9]\d*:[1-9]\d*$/.test(owner || '')) throw new Error('Missing review ownership token');
const ownershipMarker = `<!-- dot-link-review-owner:${owner} -->`;
const ownsRun = rows => rows.some(row => owned(row) && row.body.includes(ownershipMarker));
const summary = body => appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n');
const help = 'For another review, the author or a maintainer can comment `/dotlink review`.';
// Expected lifecycle transitions are dispositions, not infrastructure failures.
// Unexpected API/authentication errors deliberately propagate to Actions.
function disposition(s) {
  if (!ownsRun(s.rows)) return {state: 'Superseded', reason: 'Another run owns the review comment, or it was removed.'};
  if (s.reason) return {state: 'Skipped', reason: s.reason};
  if (s.fingerprint !== process.env.REVIEW_FINGERPRINT) return {state: 'Outdated', reason: 'The item, discussion, PR head or main changed during review.'};
  return null;
}
function finishWithoutFindings(s, d) {
  const body = `## dotsweeper review · ${d.state}\n\n${d.reason} Findings and further label changes were withheld.\n\n[Run](${runUrl})\n\n${help}`;
  // No writes to a locked target or a comment claimed by another run.
  if (d.state !== 'Superseded' && !s.issue.locked && ownsRun(s.rows)) publish(s.rows, body);
  summary(body);
  console.log(`Review disposition: ${d.state}`);
}
class InvalidResult extends Error {}
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
  if (Buffer.byteLength(input) > 150_000) throw new RangeError('Discussion exceeds review input limit');
  let diff = '';
  if (s.pr) {
    diff = gh(['api', `${root}/pulls/${number}`, '-H', 'Accept: application/vnd.github.diff']);
    if (!diff.trim() || Buffer.byteLength(diff) > 250_000 || s.pr.changed_files > 50) throw new RangeError('Change exceeds review input limit or is empty');
  }
  return {input, diff};
}
const safeText = value => {
  if (typeof value !== 'string' || value.length > 12_000) throw new InvalidResult('Invalid review text');
  if (/sk-ant-|gh[pousr]_[A-Za-z0-9]{15}|github_pat_|-----BEGIN .*PRIVATE KEY/.test(value)) throw new InvalidResult('Credential-like output withheld');
  return value.replace(/@/g, '@\u200b').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
};
function render(s) {
  const raw = process.env.REVIEW_JSON || '';
  if (Buffer.byteLength(raw) > 40_000) throw new InvalidResult('Oversized result');
  let result;
  try { result = JSON.parse(raw); } catch { throw new InvalidResult('Invalid JSON'); }
  if (!result || typeof result !== 'object') throw new InvalidResult('Invalid result');
  if (!Array.isArray(result.findings) || result.findings.length > 10) throw new InvalidResult('Invalid findings');
  let triage = null;
  if (!s.pr) {
    try { triage = validateTriage(result.triage, safeText); } catch { throw new InvalidResult('Invalid triage'); }
  }
  const files = s.pr ? new Set(get(`${root}/pulls/${number}/files?per_page=100`).map(row => row.filename)) : null;
  const blocks = result.findings.map(f => {
    if (!f || !['high', 'medium', 'low'].includes(f.severity)) throw new InvalidResult('Invalid severity');
    if (s.pr && (!files.has(f.file) || !Number.isSafeInteger(f.line) || f.line < 1)) throw new InvalidResult('Invalid PR finding location');
    return `### ${f.severity}: ${safeText(f.title)}\n\n${safeText(f.file)}${f.line ? ':' + f.line : ''}\n\n${safeText(f.reason)}`;
  });
  const body = [
    '## dotsweeper review · Complete',
    `<!-- dot-link-review-input:head=${s.data.head};main=${s.data.main};input=${s.fingerprint} -->`,
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
  const s = snapshot();
  if (s.reason) { summary(`Review skipped: ${s.reason}`); process.exit(0); }
  if (!authorized(s)) { console.log('No authorized review request.'); process.exit(0); }
  output('number', number);
  output('fingerprint', s.fingerprint);
  output('main_sha', s.data.main);
  output('owner', owner);
  try { boundedInput(s); } catch (error) {
    // API errors are not input-size errors.
    if (!(error instanceof RangeError)) throw error;
    publish(s.rows, `## dotsweeper review · Needs a smaller scope\n\nThe discussion or diff is too large, or the change is empty. No assessment was completed. Please narrow the scope and request another review.\n\n${help}`);
    process.exit(0);
  }
  publish(s.rows, `## dotsweeper review · Reviewing\n\n[Follow this run](${runUrl}). The result will replace this comment.\n\n${help}`);
  output('accepted', 'true');
} else if (mode === 'prepare') {
  output('ready', 'false');
  const s = snapshot();
  const d = disposition(s);
  if (d) { summary(`Review preparation stopped: ${d.state}. ${d.reason}`); process.exit(0); }
  if (s.data.main !== process.env.REVIEW_MAIN_SHA) throw new Error('Pinned review main does not match the accepted input');
  const {input, diff} = boundedInput(s);
  // Recheck before writing input or starting the model.
  const fresh = snapshot();
  const changed = disposition(fresh);
  if (changed) { summary(`Review preparation stopped: ${changed.state}. ${changed.reason}`); process.exit(0); }
  mkdirSync('.review', {recursive: true});
  writeFileSync('.review/input.json', input);
  writeFileSync('.review/changes.diff', diff);
  output('ready', 'true');
  console.log(`Prepared ${s.data.kind} #${number}`);
} else if (mode === 'report') {
  let s = snapshot();
  let d = disposition(s);
  if (d) { finishWithoutFindings(s, d); process.exit(process.exitCode || 0); }
  if (process.env.REVIEW_OUTCOME === 'success' && process.env.REVIEW_PREPARED === 'false') {
    finishWithoutFindings(s, {state: 'Skipped', reason: 'The input or target changed during preparation; no model assessment was started.'});
    process.exit(0);
  }
  let body, triage;
  if (process.env.REVIEW_OUTCOME !== 'success' || process.env.REVIEW_PREPARED === 'false') {
    const cancelled = process.env.REVIEW_OUTCOME === 'cancelled';
    body = `## dotsweeper review · ${cancelled ? 'Cancelled' : 'Failed'}\n\nNo completed assessment is available. A maintainer can inspect the [run](${runUrl}) for authentication, usage limits, or execution errors.\n\n${help}`;
    if (!cancelled) process.exitCode = 1;
  } else {
    try { ({body, triage} = render(s)); } catch (error) {
      if (!(error instanceof InvalidResult)) throw error;
      body = `## dotsweeper review · Failed\n\nThe result could not be validated and was withheld.\n\n[Run](${runUrl})\n\n${help}`;
      process.exitCode = 1;
    }
  }
  // Apply the same last-minute freshness/ownership check to PRs and issues.
  s = snapshot();
  d = disposition(s);
  if (d) { finishWithoutFindings(s, d); process.exit(process.exitCode || 0); }
  if (triage && !s.pr) {
    try {
      const events = JSON.parse(gh(['api', `${endpoint}/events?per_page=100`, '--paginate', '--slurp'])).flat();
      // Recheck after the events request as well; do not label a newly closed item.
      s = snapshot(); d = disposition(s);
      if (d) { finishWithoutFindings(s, d); process.exit(process.exitCode || 0); }
      const plan = planLabels((s.issue.labels || []).map(x => x.name), events, triage, botId);
      if (plan.add.length) send(`${endpoint}/labels`, {labels: plan.add});
      for (const label of plan.remove) {
        s = snapshot(); d = disposition(s);
        if (d) { finishWithoutFindings(s, d); process.exit(process.exitCode || 0); }
        const latestEvents = JSON.parse(gh(['api', `${endpoint}/events?per_page=100`, '--paginate', '--slurp'])).flat();
        const latestPlan = planLabels((s.issue.labels || []).map(x => x.name), latestEvents, triage, botId);
        if (latestPlan.remove.includes(label)) send(`${endpoint}/labels/${encodeURIComponent(label)}`, {}, 'DELETE');
      }
      body += `\n\n### Label application\n\n${plan.status} Added: ${plan.add.join(', ') || 'none'}. Removal candidates: ${plan.remove.join(', ') || 'none'} (rechecked before each removal).`;
    } catch {
      body += '\n\n### Label application\n\nLabel synchronization failed or was partial. Review findings remain available; inspect the issue labels and rerun after resolving the publishing error.';
      process.exitCode = 1;
    }
  }
  s = snapshot(); d = disposition(s);
  if (d) { finishWithoutFindings(s, d); process.exit(process.exitCode || 0); }
  publish(s.rows, body);
  summary(body);
} else throw new Error('Usage: claude-review.mjs intake|prepare|report');
