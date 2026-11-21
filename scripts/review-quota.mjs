// Durable, repository-wide bounds for model reviews requested by the public.
// Maintainers, the dependency bot and the pinned-runtime watch are unaffected;
// a maintainer can still request any review with `/dotlink review` or dispatch.
// Every count comes from records the requester cannot delete or rewrite: item
// creation times, workflow-run history and the PR timeline.
export const publicReviewLimits = Object.freeze({itemsPerDay: 10, itemsPerAuthorPerDay: 3, requestsPerAuthorPerDay: 5, readyPerItemPerDay: 3});
const DAY = 86_400_000, PAGES = 3, PAGE_SIZE = 100, MAX_INSPECTED = 50;
const time = value => { const t = Date.parse(value ?? ''); return Number.isFinite(t) ? t : NaN; };
const denied = reason => ({allowed: false, reason});

/**
 * Decide whether a public request may start the model.
 * - opened: rank among public items created in the 24 hours up to this item;
 *   the earliest items in a burst are reviewed and later ones wait for a maintainer.
 * - ready (draft marked ready) and command (`/dotlink review`): share a per-author
 *   budget counted from workflow runs that started a model review, so deleting or
 *   editing comments, toggling draft or using several items cannot reset it.
 *   Ready transitions are also bounded per PR from the timeline.
 */
export function publicReviewDecision({request, item, actor, listItems, listRequestRuns, listRunJobs, currentRunId, listTimeline, isPublic, now = Date.now()}) {
  const since = now - DAY;
  // Re-requests (comments and draft-to-ready) share one per-author budget across
  // items, counted from this author's workflow runs that started a model review.
  // Paused, refused, coalesced, cancelled or filtered runs cost nothing and do not count.
  const requestBudget = () => {
    const runs = [];
    let complete = false;
    for (let page = 1; page <= PAGES && !complete; page++) {
      const batch = listRequestRuns(page);
      if (!batch || !Array.isArray(batch.workflow_runs)) throw new Error('Invalid workflow run response.');
      runs.push(...batch.workflow_runs);
      complete = batch.workflow_runs.length < PAGE_SIZE;
    }
    if (!complete) return denied('Unusually many review requests by this author in the last 24 hours.');
    const candidates = runs.filter(run => ['issue_comment', 'pull_request_target'].includes(run.event) &&
      time(run.created_at) >= since && run.id !== currentRunId &&
      !(run.status === 'completed' && ['skipped', 'cancelled'].includes(run.conclusion)));
    if (candidates.length > MAX_INSPECTED) return denied('Unusually many review requests by this author in the last 24 hours.');
    const reviewed = run => {
      const jobs = listRunJobs(run.id);
      const job = name => jobs.find(row => row.name === name);
      if (job('intake')?.conclusion === 'skipped' || job('review')?.conclusion === 'skipped') return false;
      return run.status !== 'completed' || !!job('review');
    };
    const admitted = candidates.filter(reviewed).length + 1;
    return admitted > publicReviewLimits.requestsPerAuthorPerDay
      ? denied(`This author already reached ${publicReviewLimits.requestsPerAuthorPerDay} reviews requested in the last 24 hours.`)
      : {allowed: true};
  };
  if (request === 'command') return requestBudget();
  const created = Number.isFinite(time(item.created_at)) ? time(item.created_at) : now;
  if (request === 'ready') {
    const events = listTimeline();
    if (!Array.isArray(events)) throw new Error('Invalid timeline response.');
    const readies = events.filter(row => row.event === 'ready_for_review' && row.actor?.id === actor.id && time(row.created_at) >= since).length;
    if (readies > publicReviewLimits.readyPerItemPerDay)
      return denied(`This pull request was marked ready more than ${publicReviewLimits.readyPerItemPerDay} times in the last 24 hours.`);
    const budget = requestBudget();
    // A PR opened more than a day ago was ranked when it opened; the shared
    // per-author budget above bounds marking several old drafts ready.
    if (!budget.allowed || created < since) return budget;
  }
  const windowStart = created - DAY;
  const rows = [];
  let complete = false;
  for (let page = 1; page <= PAGES && !complete; page++) {
    const batch = listItems(page);
    if (!Array.isArray(batch)) throw new Error('Invalid issue list response.');
    rows.push(...batch);
    complete = batch.length < PAGE_SIZE || batch.some(row => time(row.created_at) < windowStart);
  }
  // More than PAGES full pages in one day is far beyond every limit: fail closed.
  if (!complete) return denied('Unusually many new issues and pull requests were opened in the 24 hours before this item.');
  const window = rows.filter(row => row.number !== item.number && isPublic(row.user) &&
    time(row.created_at) >= windowStart && (time(row.created_at) < created || (time(row.created_at) === created && row.number < item.number)));
  if (window.length >= publicReviewLimits.itemsPerDay)
    return denied(`The repository-wide limit of ${publicReviewLimits.itemsPerDay} automatic public reviews per 24 hours was reached.`);
  if (window.filter(row => row.user?.id === item.user?.id).length >= publicReviewLimits.itemsPerAuthorPerDay)
    return denied(`This author reached ${publicReviewLimits.itemsPerAuthorPerDay} automatic reviews per 24 hours.`);
  return {allowed: true};
}
