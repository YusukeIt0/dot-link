import {readFileSync} from 'node:fs';
// Read-only CI policy shared by review and both merge gates. Never execute artifacts.
export const ciRepository = 'YusukeIt0/dot-link';
export const ciPath = '.github/workflows/ci.yml';
export const requiredCIJobs = JSON.parse(readFileSync(new URL('../config/development-policy.json', import.meta.url), 'utf8')).requiredJobs;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function ciTarget(pr, base) {
  const target = {number: pr.number, head: pr.head?.sha, headRef: pr.head?.ref,
    headRepository: pr.head?.repo?.full_name, baseRef: base?.ref || pr.base?.ref,
    base: base?.sha || pr.base?.sha};
  if (!Number.isSafeInteger(target.number) || !sha(target.head) || !sha(target.base) ||
      !target.headRef || !target.headRepository || !target.baseRef) throw new Error('CI target is incomplete.');
  return target;
}

export const ciReceipt = target => `CI v1 | pr=${target.number} | head=${target.head} | base=${target.base} | ref=${target.baseRef}`;
export const ciHeadReceipt = target => ciReceipt(target).replace('CI v1', 'CI v2');
const hasReceipt = run => /^CI v[12] \| pr=[1-9]\d* \| head=[a-f0-9]{40} \| base=[a-f0-9]{40} \| ref=\S+$/.test(run.display_title || '');
function associatedCI(run, target) {
  return run?.path === ciPath && run.repository?.full_name === ciRepository &&
    run.event === 'pull_request' && run.head_sha === target.head && run.head_branch === target.headRef &&
    run.head_repository?.full_name === target.headRepository &&
    run.pull_requests?.some(p => p.number === target.number && p.head?.sha === target.head);
}
export function headReceipt(run, target) {
  const prefix = `CI v2 | pr=${target.number} | head=${target.head} | base=`;
  return typeof run?.display_title === 'string' && run.display_title.startsWith(prefix) &&
    /^[a-f0-9]{40} \| ref=\S+$/.test(run.display_title.slice(prefix.length));
}
export function baseIncluded(target, comparison) {
  return ['ahead', 'identical'].includes(comparison?.status) &&
    comparison?.merge_base_commit?.sha === target.base;
}
export function matchesCI(run, target) {
  return associatedCI(run, target) && (headReceipt(run, target) ||
    run.display_title === ciReceipt(target) &&
    run.pull_requests.some(p => p.number === target.number && p.base?.ref === target.baseRef && p.base?.sha === target.base));
}

export function selectCI(runs, target) {
  if (!Array.isArray(runs)) throw new Error('Invalid CI response.');
  // v1 requires the original base; v2 proves the exact head plus current ancestry.
  // Missing provenance on a newer associated run must HOLD, not revive old green.
  return runs.filter(run => run?.path === ciPath && run.repository?.full_name === ciRepository &&
    run.event === 'pull_request' && run.head_sha === target.head &&
    run.display_title !== `CI ignored | pr=${target.number} | head=${target.head}` &&
    (!run.head_branch || run.head_branch === target.headRef) &&
    (!run.head_repository?.full_name || run.head_repository.full_name === target.headRepository) &&
    (!run.pull_requests?.length || run.pull_requests.some(p => p.number === target.number)) &&
    (!hasReceipt(run) || headReceipt(run, target) || run.display_title === ciReceipt(target)))
    .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
}

export function assertCI(target, run, jobs, comparison) {
  if (!matchesCI(run, target) || (headReceipt(run, target) && !baseIncluded(target, comparison)) || !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 || run.status !== 'completed' || run.conclusion !== 'success' ||
      !Array.isArray(jobs) || jobs.some(j => j.status !== 'completed' || j.conclusion !== 'success') ||
      requiredCIJobs.some(name => jobs.filter(j => j.name === name).length !== 1)) {
    throw new Error('Full PR CI must succeed for the exact head with the current base included; skipped is not success.');
  }
}

export function collectCI(pr, base, api, pages) {
  const target = ciTarget(pr, base), runs = [];
  // Explicit pagination also bounds GitHub's 1,000-result filtered search limit.
  for (let page = 1; page <= 10; page++) {
    const result = api(`actions/workflows/ci.yml/runs?head_sha=${target.head}&per_page=100&page=${page}`);
    if (!Array.isArray(result.workflow_runs) || result.total_count > 1000) throw new Error('CI enumeration is incomplete.');
    runs.push(...result.workflow_runs);
    if (result.workflow_runs.length < 100) break;
    if (page === 10) throw new Error('CI enumeration exceeded its safe bound.');
  }
  const run = selectCI(runs, target);
  const jobs = run ? pages(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).flatMap(p => {
    if (!Array.isArray(p.jobs)) throw new Error('Invalid CI jobs response.');
    return p.jobs;
  }) : [];
  if (run) {
    const fresh = api(`actions/runs/${run.id}`);
    const identity = r => [r.id, r.run_attempt, r.status, r.conclusion, r.head_sha,
      r.head_branch, r.display_title, r.path, r.repository?.full_name, r.head_repository?.full_name,
      matchesCI(r, target)];
    if (JSON.stringify(identity(run)) !== JSON.stringify(identity(fresh))) throw new Error('CI changed while collecting jobs.');
  }
  const comparison = headReceipt(run, target) ? api(`compare/${target.base}...${target.head}`) : undefined;
  let status = 'ready', reason = 'Current PR validation succeeded.';
  try { assertCI(target, run, jobs, comparison); }
  catch (error) { status = 'held'; reason = run ? error.message : 'No PR CI matches the current head and base.'; }
  return {target, run, jobs, comparison, status, reason};
}
