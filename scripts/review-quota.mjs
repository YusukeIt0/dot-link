// Durable, repository-wide bounds for model reviews requested by the public.
// Maintainers, the dependency bot and the pinned-runtime watch are unaffected;
// a maintainer can still request any review with `/dotlink review` or dispatch.
// State comes from GitHub itself (item creation times and command comments),
// so no extra storage or credential is needed and every intake sees the same data.
export const publicReviewLimits = Object.freeze({itemsPerDay: 10, itemsPerAuthorPerDay: 3, requestsPerItemPerDay: 3});
const DAY = 86_400_000, PAGES = 3, PAGE_SIZE = 100;
const time = value => { const t = Date.parse(value ?? ''); return Number.isFinite(t) ? t : NaN; };

/**
 * Decide whether a public request may start the model.
 * - opened items: rank among public items created in the 24 hours up to this item;
 *   the earliest items in a burst are reviewed and later ones wait for a maintainer.
 * - author re-requests: exact `/dotlink review` comments by that author on this item in 24 hours.
 * `listItems(page)` returns one page of issues/PRs sorted by creation, newest first.
 */
export function publicReviewDecision({request, item, actor, comments = [], listItems, isPublic, now = Date.now()}) {
  if (request === 'command') {
    const since = now - DAY;
    const requests = comments.filter(row => row.user?.id === actor.id && row.body === '/dotlink review' && time(row.created_at) >= since).length;
    return requests > publicReviewLimits.requestsPerItemPerDay
      ? {allowed: false, reason: `This author already requested ${publicReviewLimits.requestsPerItemPerDay} reviews of this item in the last 24 hours.`}
      : {allowed: true};
  }
  const created = Number.isFinite(time(item.created_at)) ? time(item.created_at) : now;
  const since = created - DAY;
  const rows = [];
  let complete = false;
  for (let page = 1; page <= PAGES && !complete; page++) {
    const batch = listItems(page);
    if (!Array.isArray(batch)) throw new Error('Invalid issue list response.');
    rows.push(...batch);
    complete = batch.length < PAGE_SIZE || batch.some(row => time(row.created_at) < since);
  }
  // More than PAGES full pages in one day is far beyond every limit: fail closed.
  if (!complete) return {allowed: false, reason: 'Unusually many new issues and pull requests were opened in the last 24 hours.'};
  const window = rows.filter(row => row.number !== item.number && isPublic(row.user) &&
    time(row.created_at) >= since && (time(row.created_at) < created || (time(row.created_at) === created && row.number < item.number)));
  if (window.length >= publicReviewLimits.itemsPerDay)
    return {allowed: false, reason: `The repository-wide limit of ${publicReviewLimits.itemsPerDay} automatic public reviews per 24 hours was reached.`};
  if (window.filter(row => row.user?.id === item.user?.id).length >= publicReviewLimits.itemsPerAuthorPerDay)
    return {allowed: false, reason: `This author reached ${publicReviewLimits.itemsPerAuthorPerDay} automatic reviews per 24 hours.`};
  return {allowed: true};
}
