// Fail-closed coordinator. Default is read-only; never execute reviewed code.
import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {latestReceipt, assertReady} from './check-review-before-merge.mjs';
import {policy, trustedUser, gatherContext, scopeRevision, reviewDiscussion, validateAssessment, acceptanceBlockers, hash, versionFiles, versionOnly, readMetadata, authenticateComments, commentRevisionQuery, websiteOnlyAsset} from './review-evidence.mjs';

export const repository = 'YusukeIt0/dot-link';
export {versionOnly};

export function deviceAffected(files) {
  return files.some(f => [f.filename, f.previous_filename].filter(Boolean).some(path =>
    ['src/', 'server/', 'native/', 'public/'].some(root => path.startsWith(root)) ||
    path.startsWith('assets/') && !websiteOnlyAsset(path)));
}

export function protectedChanges(files, versionChanges = {}) {
  const protectedPath = path => policy.protectedPaths.some(x => x.endsWith('/') ? path.startsWith(x) : path === x);
  return files.filter(file => [file.filename, file.previous_filename].filter(Boolean).some(path => {
    if (protectedPath(path)) return true;
    if (versionFiles.has(path)) return file.status !== 'modified' || versionChanges[path] !== true;
    if (path === 'README.md') return false;
    return !policy.allowedRoots.some(root => path.startsWith(root));
  })).map(x => x.filename);
}

export function assertProtection(protection) {
  const checks = protection?.required_status_checks;
  if (checks?.strict !== true || !checks.checks?.some(x => x.context === 'test' && x.app_id === 15368) ||
      protection.enforce_admins?.enabled !== true || protection.allow_force_pushes?.enabled !== false ||
      protection.allow_deletions?.enabled !== false || !protection.required_pull_request_reviews) {
    throw new Error('Main protection is missing or weaker than the accepted baseline.');
  }
}

export function assertProductCI(pr, main, run, jobs) {
  const association = run?.event === 'push'
    ? run.head_branch === pr.head.ref && pr.head.repo?.full_name === repository
    : run?.event === 'pull_request' && run.pull_requests?.some(x => x.number === pr.number && x.base?.ref === 'main' && x.base?.sha === main);
  if (!association || run?.path !== '.github/workflows/ci.yml' || run?.head_sha !== pr.head.sha ||
      run?.repository?.full_name !== repository || run?.status !== 'completed' || run?.conclusion !== 'success' ||
      !Array.isArray(jobs) || jobs.some(x => x.status !== 'completed' || x.conclusion !== 'success') ||
      policy.requiredJobs.some(name => jobs.filter(x => x.name === name).length !== 1)) {
    throw new Error('Exact-head product CI and every required job must complete successfully; skipped is not success.');
  }
}

export function evaluate(snapshot) {
  const reasons = [];
  const {pr, main, protection, files, versionChanges, context, receipt, reviews = [], ciRun, ciJobs, ancestry} = snapshot;
  if (!trustedUser(pr.user) || pr.head.repo?.full_name !== repository) reasons.push('PR author/head is not an explicitly trusted in-repository contributor.');
  if (pr.base?.ref !== 'main') reasons.push('Automatic merging only targets protected main; dependent PRs need their normal integration sequence.');
  const sensitive = protectedChanges(files, versionChanges);
  if (sensitive.length) reasons.push(`Human merge decision required for control-plane or unclassified changes: ${sensitive.join(', ')}`);
  if (files.length !== pr.changed_files) reasons.push('Changed-file enumeration is incomplete.');
  if (!['ahead', 'identical'].includes(ancestry?.status) || ancestry?.merge_base_commit?.sha !== main) reasons.push('PR head does not contain the current main commit.');
  const latestReviews = new Map();
  for (const review of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latestReviews.set(review.user?.id, review);
  if ([...latestReviews.values()].some(x => x.state === 'CHANGES_REQUESTED')) reasons.push('A review requests changes; resolve and re-review it.');
  for (const check of [() => assertProtection(protection), () => assertProductCI(pr, main, ciRun, ciJobs), () => assertReady(snapshot)]) {
    try { check(); } catch (error) { reasons.push(error.message); }
  }
  const quality = receipt?.quality;
  if (!quality || quality.version !== 1 || !Number.isSafeInteger(quality.findings) || quality.findings < 0 || quality.findings > 10) {
    reasons.push('No machine-readable independent review assessment.');
  } else {
    if (quality.findings !== 0) reasons.push('Technical findings remain; severity alone does not waive them.');
    const acceptance = context?.acceptance;
    if (quality.acceptance?.status !== 'ready' || acceptance?.status !== 'ready' ||
        quality.acceptance.comment_id !== acceptance.comment_id || quality.acceptance.digest !== acceptance.digest ||
        quality.acceptance.scope_digest !== context.scope?.digest) reasons.push('Acceptance evidence was not independently reviewed at its current revision.');
    try {
      const assessment = validateAssessment(quality.assessment, context);
      reasons.push(...acceptanceBlockers(acceptance, assessment));
      if (deviceAffected(files) && assessment.device !== 'recorded') reasons.push('Runtime-affecting changes require applicable recorded physical acceptance.');
    } catch { reasons.push('Independent acceptance assessment is invalid or missing.'); }
  }
  return {eligible: reasons.length === 0, number: pr.number, head: pr.head.sha, main,
    receipt: receipt?.runId, reasons: [...new Set(reasons)]};
}

export function collect(number, client) {
  const {api, pages, checks} = client;
  const pr = api(`pulls/${number}`);
  if (!pr.head?.sha || pr.state !== 'open' || pr.draft || pr.base?.ref !== 'main') {
    throw new Error('PR is not open, ready and targeting main.');
  }
  const main = api('commits/main').sha;
  const botId = api('actions/variables/DOTSWEEPER_BOT_ID').value;
  const comments = authenticateComments(pages(`issues/${number}/comments?per_page=100`), client.readNode, botId);
  const receipt = latestReceipt(comments, botId);
  const run = api(`actions/runs/${receipt.runId}`);
  const jobs = pages(`actions/runs/${receipt.runId}/jobs?filter=latest&per_page=100`).flatMap(x => x.jobs);
  const files = pages(`pulls/${number}/files?per_page=100`);
  if (files.length > 100) throw new Error('Automatic merging requires a bounded changed-file set.');
  const versionChanges = {};
  for (const f of files.filter(x => versionFiles.has(x.filename) && x.status === 'modified')) {
    versionChanges[f.filename] = versionOnly(f.filename, readMetadata(api, f.filename, main), readMetadata(api, f.filename, pr.head.sha));
  }
  const scope = scopeRevision(comments, pr.head.sha, api, pages);
  const feedback = reviewDiscussion(pr.number, pages);
  const context = gatherContext({pr, issue: {number: pr.number}, rows: comments, fingerprint: receipt.fingerprint}, api, pages);
  const runs = api(`actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&per_page=100`).workflow_runs;
  // Select the latest associated run, not an older successful attempt.
  const ciRun = runs.filter(x => x.event === 'push' && x.head_branch === pr.head.ref && pr.head.repo?.full_name === repository ||
    x.event === 'pull_request' && x.pull_requests?.some(p => p.number === pr.number && p.base?.ref === 'main' && p.base?.sha === main))
    .sort((a, b) => b.id - a.id)[0];
  const ciJobs = ciRun ? pages(`actions/runs/${ciRun.id}/jobs?filter=latest&per_page=100`).flatMap(x => x.jobs) : [];
  return {pr, main, scope, feedback, comments, receipt, run, jobs, files, versionChanges, context, ciRun, ciJobs,
    checks: checks(number), protection: api('branches/main/protection'),
    reviews: pages(`pulls/${number}/reviews?per_page=100`),
    ancestry: api(`compare/${main}...${pr.head.sha}`)};
}

export function assertActivation(env, activation) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== repository ||
      env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/auto-merge.yml@refs/heads/main` ||
      env.DOTLINK_AUTO_MERGE_ENABLED !== policy.activationValue || activation !== policy.activationValue ||
      !env.AUTO_MERGE_TOKEN) throw new Error('Automatic merging is not activated for this trusted main workflow.');
}

// GitHub can return the same JSON objects with different property insertion
// orders, including under the same App token. Compare every value while treating
// object-key order as immaterial. Array order and element values remain intact.
export function snapshotHash(value) {
  const canonical = x => Array.isArray(x) ? x.map(canonical)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(key => [key, canonical(x[key])])) : x;
  return hash(canonical(value));
}

export function mergeEligible(number, client, env) {
  assertActivation(env, client.api('actions/variables/DOTLINK_AUTO_MERGE_ENABLED').value);
  const first = collect(number, client), decision = evaluate(first);
  if (!decision.eligible) return {...decision, merged: false};
  // Re-read all live inputs before the mutation; never queue a future merge using
  // a stale green result. GitHub enforces branch protection and exact-head CAS.
  const final = collect(number, client), ready = evaluate(final);
  const changed = snapshotHash(first) !== snapshotHash(final);
  const changedInputs = Object.keys({...first, ...final}).filter(key => snapshotHash({value: first[key]}) !== snapshotHash({value: final[key]}));
  if (!ready.eligible || changed) return {...ready, eligible: false, merged: false,
    retryable: ready.eligible && changed, changed_inputs: changedInputs,
    reasons: [...ready.reasons, 'Inputs changed during the final merge check.']};
  assertActivation(env, client.api('actions/variables/DOTLINK_AUTO_MERGE_ENABLED').value);
  const result = client.merge(number, {sha: ready.head, merge_method: 'squash'});
  if (result.merged !== true || !/^[a-f0-9]{40}$/.test(result.sha || '')) throw new Error('GitHub did not confirm a merge.');
  return {...ready, merged: true, merge_commit: result.sha};
}

export async function mergeWithReassessment(number, client, env, wait = delay) {
  const delays = [30_000, 60_000], reassessments = [];
  for (let attempt = 0; ; attempt++) {
    // Never replay a merge mutation: only an explicitly retryable pre-write
    // snapshot hold reaches this loop. Activation and all gates run afresh.
    const decision = mergeEligible(number, client, env);
    if (!decision.retryable || attempt === delays.length) {
      return {...decision, attempts: attempt + 1, reassessments};
    }
    reassessments.push({attempt: attempt + 1, delay_seconds: delays[attempt] / 1000,
      changed_inputs: decision.changed_inputs});
    console.error(`PR #${number}: final inputs changed (${decision.changed_inputs.join(', ')}); reassessing in ${delays[attempt] / 1000}s.`);
    await wait(delays[attempt]);
  }
}

function githubClient(env) {
  const command = (args, options = {}) => JSON.parse(execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 8_000_000, ...options}));
  return {
    api: path => command(['api', `repos/${repository}/${path}`]),
    readNode: id => command(['api', 'graphql', '-f', `query=${commentRevisionQuery}`, '-F', `id=${id}`]).data.node,
    pages: path => command(['api', `repos/${repository}/${path}`, '--paginate', '--slurp']).flat(),
    checks: number => {
      try { return command(['pr', 'checks', String(number), '--repo', repository, '--required', '--json', 'name,state,bucket']); }
      catch (error) {
        if ([1, 8].includes(error.status) && error.stdout?.trim().startsWith('[')) return JSON.parse(error.stdout);
        throw error;
      }
    },
    merge: (number, body) => command(['api', `repos/${repository}/pulls/${number}/merge`, '-X', 'PUT', '--input', '-'],
      {input: JSON.stringify(body), env: {...env, GH_TOKEN: env.AUTO_MERGE_TOKEN}}),
  };
}

async function main() {
  const [mode = '--dry-run', number] = process.argv.slice(2);
  if (!['--dry-run', '--execute'].includes(mode) || (number && !/^[1-9]\d{0,8}$/.test(number)) || process.argv.length > 4) {
    throw new Error('Usage: node scripts/auto-merge.mjs [--dry-run|--execute] [PR-number]');
  }
  const client = githubClient(process.env);
  if (mode === '--execute') assertActivation(process.env, client.api('actions/variables/DOTLINK_AUTO_MERGE_ENABLED').value);
  const candidates = number ? [Number(number)] : client.api('pulls?state=open&base=main&per_page=100')
    .filter(x => trustedUser(x.user) && !x.draft).map(x => x.number);
  if (candidates.length > 20) throw new Error('Too many candidates; inspect the backlog or dispatch one PR explicitly.');
  const results = [];
  for (const n of candidates) {
    try {
      const decision = mode === '--execute' ? await mergeWithReassessment(n, client, process.env) : evaluate(collect(n, client));
      results.push(decision);
      if (decision.merged) break; // main moved: later work must use new review/CI evidence.
    } catch (error) {
      results.push({number: n, eligible: false, reasons: [error.message.slice(0, 1500)]});
    }
  }
  console.log(JSON.stringify({mode, results}, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Automatic merge ${mode === '--execute' ? 'execution' : 'dry run'}\n\n` +
    (results.map(x => `- #${x.number}: ${x.merged ? 'merged' : x.eligible ? 'eligible, no write' : 'held'}${x.reasons?.length ? ' — ' + x.reasons.join(' ') : ''}`).join('\n') || 'No eligible-author open PRs.') + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
