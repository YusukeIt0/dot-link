// Durable, repository-wide bounds for model reviews requested by the public.
// Maintainers, the dependency bot and the pinned-runtime watch are unaffected;
// a maintainer can still request any review with `/dotlink review` or dispatch.
// Every count comes from records the requester cannot delete or rewrite: item
// creation times, workflow-run history and the PR timeline.
export const publicReviewLimits = Object.freeze({itemsPerDay: 10, itemsPerAuthorPerDay: 3, commandsPerAuthorPerDay: 5, readyPerItemPerDay: 3});
const DAY = 86_400_000, PAGES = 3, PAGE_SIZE = 100, MAX_UNFINISHED = 20;
const time = value => { const t = Date.parse(value ?? ''); return Number.isFinite(t) ? t : NaN; };
const denied = reason => ({allowed: false, reason});

/**
 * Decide whether a public request may start the model.
 * - opened: rank among public items created in the 24 hours up to this item;
 *   the earliest items in a burst are reviewed and later ones wait for a maintainer.
 * - ready (draft marked ready): also bounded by this actor's ready events on the item.
 * - command (`/dotlink review` or other admitted comment events): bounded by this
 *   actor's admitted comment-triggered runs, so deleting or editing comments cannot reset it.
 */
export function publicReviewDecision({request, item, actor, listItems, listCommandRuns, listRunJobs, currentRunId, listTimeline, isPublic, now = Date.now()}) {
  const since = now - DAY;
  if (request === 'command') {
    // Every comment event creates a run; ones rejected by the job filter finish as
    // skipped within seconds. Count only runs that reached intake, so ordinary
    // comments never use up the author's requests.
    const runs = [];
    let complete = false;
    for (let page = 1; page <= PAGES && !complete; page++) {
      const batch = listCommandRuns(page);
      if (!batch || !Array.isArray(batch.workflow_runs)) throw new Error('Invalid workflow run response.');
      runs.push(...batch.workflow_runs);
      complete = batch.workflow_runs.length < PAGE_SIZE;
    }
    if (!complete) return denied('Unusually many review requests by this author in the last 24 hours.');
    const recent = runs.filter(run => time(run.created_at) >= since && run.id !== currentRunId);
    const unfinished = recent.filter(run => run.status !== 'completed');
    if (unfinished.length > MAX_UNFINISHED) return denied('Unusually many review requests by this author are still running.');
    // An unfinished run counts unless its intake job was already skipped.
    const admitted = recent.filter(run => run.status === 'completed' ? run.conclusion !== 'skipped'
      : !listRunJobs(run.id).some(job => job.name === 'intake' && job.conclusion === 'skipped')).length + 1;
    return admitted > publicReviewLimits.commandsPerAuthorPerDay
      ? denied(`This author already requested ${publicReviewLimits.commandsPerAuthorPerDay} reviews in the last 24 hours.`)
      : {allowed: true};
  }
  if (request === 'ready') {
    const events = listTimeline();
    if (!Array.isArray(events)) throw new Error('Invalid timeline response.');
    const readies = events.filter(row => row.event === 'ready_for_review' && row.actor?.id === actor.id && time(row.created_at) >= since).length;
    if (readies > publicReviewLimits.readyPerItemPerDay)
      return denied(`This pull request was marked ready more than ${publicReviewLimits.readyPerItemPerDay} times in the last 24 hours.`);
  }
  const created = Number.isFinite(time(item.created_at)) ? time(item.created_at) : now;
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
  if (!complete) return denied('Unusually many new issues and pull requests were opened in the last 24 hours.');
  const window = rows.filter(row => row.number !== item.number && isPublic(row.user) &&
    time(row.created_at) >= windowStart && (time(row.created_at) < created || (time(row.created_at) === created && row.number < item.number)));
  if (window.length >= publicReviewLimits.itemsPerDay)
    return denied(`The repository-wide limit of ${publicReviewLimits.itemsPerDay} automatic public reviews per 24 hours was reached.`);
  if (window.filter(row => row.user?.id === item.user?.id).length >= publicReviewLimits.itemsPerAuthorPerDay)
    return denied(`This author reached ${publicReviewLimits.itemsPerAuthorPerDay} automatic reviews per 24 hours.`);
  return {allowed: true};
}
