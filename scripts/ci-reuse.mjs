// Reuse execution, not integration/review authority. Never read run artifacts/logs.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {ciRepository, ciPath, ciHeadReceipt} from './ci-evidence.mjs';

export const fullProductStep = 'Run full product validation';
export const reuseMaxAgeMs = 24 * 60 * 60 * 1000;
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const positive = value => Number.isSafeInteger(value) && value > 0;
const trusted = actor => actor?.id === 213780070 && actor?.login === 'YusukeIt0';
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;

export function sourceRunEligible(run, context) {
  return positive(run?.id) && positive(run.run_attempt) && run.id !== context.runId &&
    run.repository?.full_name === ciRepository && run.head_repository?.full_name === ciRepository &&
    run.path === ciPath && ['pull_request', 'push'].includes(run.event) &&
    (run.event !== 'push' || run.head_branch === 'main') &&
    trusted(run.actor) && trusted(run.triggering_actor) && sha(run.head_sha) &&
    run.status === 'completed' && run.conclusion === 'success' &&
    stamp(run.run_started_at) <= context.now && stamp(run.run_started_at) >= context.now - reuseMaxAgeMs &&
    stamp(run.updated_at) <= context.now && stamp(run.updated_at) >= stamp(run.run_started_at);
}

function runIdentity(run) {
  return JSON.stringify([run.id, run.run_attempt, run.head_sha, run.status, run.conclusion,
    run.path, run.event, run.head_branch, run.repository?.full_name, run.head_repository?.full_name,
    run.actor?.id, run.actor?.login, run.triggering_actor?.id, run.triggering_actor?.login,
    run.run_started_at, run.updated_at, run.workflow_id, run.display_title]);
}

export function fullProductEvidence(jobs, run) {
  if (!Array.isArray(jobs) || jobs.length !== 2 ||
      jobs.some(j => j.run_id !== run.id || j.head_sha !== run.head_sha ||
        j.status !== 'completed' || j.conclusion !== 'success')) return null;
  if (jobs.filter(j => j.name === 'workflow-lint').length !== 1 || jobs.filter(j => j.name === 'test').length !== 1) return null;
  const job = jobs.find(j => j.name === 'test');
  if (!job.labels?.includes('macos-15') || !Array.isArray(job.steps)) return null;
  const steps = job.steps.filter(s => s.name === fullProductStep);
  if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') return null;
  const ms = stamp(steps[0].completed_at) - stamp(steps[0].started_at);
  return Number.isFinite(ms) && ms > 0 ? {seconds: ms / 1000} : null;
}

export function gitTreeProof(source, head, cwd = '.') {
  if (!sha(source) || !sha(head)) return null;
  try {
    const git = args => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    if (git(['merge-base', source, head]) !== source) return null;
    const tree = git(['rev-parse', `${head}^{tree}`]);
    return sha(tree) && git(['rev-parse', `${source}^{tree}`]) === tree ? tree : null;
  } catch { return null; }
}

export function readmeTreeProof(source, head, base, cwd = '.') {
  if (![source, head, base].every(sha)) return null;
  try {
    const git = args => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    if (git(['merge-base', base, source]).trim() !== base ||
        git(['merge-base', source, head]).trim() !== source) return null;
    // The integrated workflow defines the run title and the full-product step.
    if (git(['rev-parse', base + ':' + ciPath]) !== git(['rev-parse', source + ':' + ciPath])) return null;
    const diff = git(['diff', '--raw', '--no-abbrev', '--no-renames', '-z', source, head, '--']);
    if (!/^:100644 100644 [a-f0-9]{40} [a-f0-9]{40} M\x00README\.md\x00$/.test(diff)) return null;
    return git(['rev-parse', head + '^{tree}']).trim();
  } catch { return null; }
}

function readmeTarget(env, head) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || !env.GITHUB_EVENT_PATH) return null;
  try {
    const {pull_request: pr} = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    if (!positive(pr?.number) || pr.head?.repo?.full_name !== ciRepository || pr.base?.repo?.full_name !== ciRepository ||
        pr.head.sha !== head || !pr.head.ref || pr.base.ref !== 'main' || !sha(pr.base.sha)) return null;
    return {number: pr.number, headRef: pr.head.ref, baseRef: pr.base.ref, base: pr.base.sha};
  } catch { return null; }
}

export function reuseContext(env = process.env, now = Date.now()) {
  const context = {repository: env.GITHUB_REPOSITORY, head: env.CI_HEAD || env.GITHUB_SHA,
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), now};
  // A manual rerun is the explicit full-verification escape hatch.
  if (env.GITHUB_ACTIONS !== 'true' || context.repository !== ciRepository ||
      !positive(context.runId) || context.attempt !== 1 || !sha(context.head) || !Number.isFinite(now)) return null;
  const target = readmeTarget(env, context.head);
  return target ? {...context, target} : context;
}

export function githubReader(token) {
  return async path => {
    if (!token) throw new Error('Missing read-only Actions credential.');
    const response = await fetch(`https://api.github.com/repos/${ciRepository}/${path}`, {
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json'},
      redirect: 'error', signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw new Error('Cannot verify reusable product evidence.');
    return response.json();
  };
}

function matchesReadmeRun(run, target, head) {
  return target && run?.event === 'pull_request' && run.head_sha === head && run.head_branch === target.headRef &&
    run.repository?.full_name === ciRepository && run.head_repository?.full_name === ciRepository &&
    run.path === ciPath && positive(run.workflow_id) && trusted(run.actor) && trusted(run.triggering_actor) &&
    run.display_title === ciHeadReceipt({...target, head});
}

function executionProof(run, context, treeProof, readmeProof) {
  const tree = treeProof(run.head_sha, context.head);
  if (tree) return {tree};
  if (!matchesReadmeRun(run, context.target, run.head_sha)) return null;
  const changed = readmeProof(run.head_sha, context.head, context.target.base);
  return changed ? {tree: changed, readmeOnly: true} : null;
}

async function currentReadmeRun(source, context, get) {
  const target = context.target;
  const current = await get('actions/runs/' + context.runId);
  if (current.id !== context.runId || current.run_attempt !== context.attempt ||
      current.workflow_id !== source.workflow_id || !matchesReadmeRun(current, target, context.head)) return false;
  const pr = await get('pulls/' + target.number);
  if (pr.state !== 'open' || pr.number !== target.number || pr.head?.sha !== context.head ||
      pr.head?.ref !== target.headRef || pr.head?.repo?.full_name !== ciRepository ||
      pr.base?.sha !== target.base || pr.base?.ref !== target.baseRef || pr.base?.repo?.full_name !== ciRepository) return false;
  const ref = await get('git/ref/heads/main');
  return ref.ref === 'refs/heads/main' && ref.object?.type === 'commit' && ref.object.sha === target.base;
}

export async function verifyReuse(id, context, get, treeProof = gitTreeProof, readmeProof = readmeTreeProof) {
  if (!context || !positive(id)) return null;
  const run = await get(`actions/runs/${id}`);
  if (run.id !== id || !sourceRunEligible(run, context)) return null;
  const proof = executionProof(run, context, treeProof, readmeProof);
  if (!proof || (proof.readmeOnly && !await currentReadmeRun(run, context, get))) return null;
  // Do not revive an older green run after a newer attempt/run for its source.
  const recent = await get(`actions/workflows/ci.yml/runs?head_sha=${run.head_sha}&per_page=100&page=1`);
  if (!Array.isArray(recent.workflow_runs) || !Number.isSafeInteger(recent.total_count) || recent.total_count > 100) return null;
  const latest = [...recent.workflow_runs].filter(r => r.id !== context.runId)
    .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
  if (!latest || runIdentity(latest) !== runIdentity(run)) return null;
  const response = await get(`actions/runs/${id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  if (response.total_count !== 2) return null;
  const evidence = fullProductEvidence(response.jobs, run);
  if (!evidence) return null;
  const fresh = await get(`actions/runs/${id}`);
  if (runIdentity(fresh) !== runIdentity(run)) return null;
  return {run: id, attempt: run.run_attempt, source: run.head_sha, ...proof,
    url: `https://github.com/${ciRepository}/actions/runs/${id}/attempts/${run.run_attempt}`,
    productSeconds: evidence.seconds};
}

export async function discoverReuse(context, get, treeProof = gitTreeProof, readmeProof = readmeTreeProof) {
  if (!context) return null;
  try {
    // Bounded opportunistic search. Missing evidence always retains full execution.
    const response = await get('actions/workflows/ci.yml/runs?per_page=100&page=1');
    if (!Array.isArray(response.workflow_runs)) return null;
    const seen = new Set();
    let probes = 0;
    for (const run of [...response.workflow_runs].sort((a, b) => b.id - a.id)) {
      if (run.id === context.runId) continue;
      if (seen.has(run.head_sha)) continue;
      seen.add(run.head_sha);
      if (!sourceRunEligible(run, context) || !executionProof(run, context, treeProof, readmeProof)) continue;
      if (++probes > 5) break;
      const evidence = await verifyReuse(run.id, context, get, treeProof, readmeProof);
      if (evidence) return evidence;
    }
  } catch { /* A lookup failure is not coverage. */ }
  return null;
}
