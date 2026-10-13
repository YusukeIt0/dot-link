import {readFileSync} from 'node:fs';
export const catalog = JSON.parse(readFileSync(new URL('../config/review-labels.json', import.meta.url), 'utf8'));
export const priorities = ['P0', 'P1', 'P2', 'P3'];
export const categories = catalog.map(x => x.name).filter(x => !priorities.includes(x) && x !== 'triage:manual');
export function validateTriage(value, safeText) {
  if (!value || ![null, ...priorities].includes(value.priority) || !Array.isArray(value.labels) || value.labels.length > 8) throw new Error('Invalid triage');
  const reason = safeText(value.priority_reason);
  if (!reason.trim()) throw new Error('Missing priority rationale');
  const seen = new Set();
  const labels = value.labels.map(row => {
    if (!categories.includes(row.name) || seen.has(row.name)) throw new Error('Unknown or duplicate label');
    seen.add(row.name);
    const reason = safeText(row.reason);
    if (!reason.trim()) throw new Error('Missing label rationale');
    return {name: row.name, reason};
  });
  return {priority: value.priority, priority_reason: reason, labels};
}
// Existing priorities always win, including earlier bot priorities. Remove the
// priority and request review explicitly when reclassification is wanted.
export function planLabels(current, events, triage, botId) {
  if (current.includes('triage:manual')) return {add: [], remove: [], status: 'Manual triage lock; labels unchanged.'};
  const desired = new Set(triage.labels.map(x => x.name));
  if (!current.some(x => priorities.includes(x)) && triage.priority) desired.add(triage.priority);
  const latest = new Map();
  for (const event of events) if (['labeled', 'unlabeled'].includes(event.event) && event.label?.name) latest.set(event.label.name, event);
  const botOwned = event => String(event?.actor?.id) === String(botId) && event?.actor?.login === 'dotsweeper[bot]' && event?.actor?.type === 'Bot';
  const add = [...desired].filter(name => !current.includes(name) &&
    (priorities.includes(name) || !latest.has(name) || botOwned(latest.get(name))));
  const remove = current.filter(name => categories.includes(name) && !desired.has(name) &&
    latest.get(name)?.event === 'labeled' && botOwned(latest.get(name)));
  return {add, remove, status: current.some(x => priorities.includes(x)) ? 'Existing priority preserved; bot-owned categories reconciled.' : 'Allowed labels reconciled; human label decisions preserved.'};
}
