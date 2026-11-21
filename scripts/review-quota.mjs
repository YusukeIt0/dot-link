// Durable, repository-wide bounds for model reviews requested by the public.
// Maintainers, the dependency bot and the pinned-runtime watch are unaffected;
// a maintainer can still request any review with `/dotlink review` or dispatch.
// Every count comes from records the requester cannot delete or rewrite: item
// creation times, workflow-run history and the PR timeline.
export const publicReviewLimits = Object.freeze({itemsPerDay: 10, itemsPerAuthorPerDay: 3, commandsPerAuthorPerDay: 5, readyPerItemPerDay: 3});
const DAY = 86_400_000, PAGES = 3, PAGE_SIZE = 100;
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
export function publicReviewDecision({request, item, actor, listItems, listCommandRuns, listTimeline, isPublic, now = Date.now()}) {
  const since = now - DAY;
  if (request === 'command') {
    const runs = listCommandRuns();
    if (!runs || !Array.isArray(runs.workflow_runs)) throw new Error('Invalid workflow run response.');
    if (runs.total_count > PAGE_SIZE) return denied('Unusually many review requests by this author in the last 24 hours.');
    const admitted = runs.workflow_runs.filter(run => run.conclusion !== 'skipped' && time(run.created_at) >= since).length;
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
