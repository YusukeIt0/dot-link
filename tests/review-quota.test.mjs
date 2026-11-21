import test from 'node:test';
import assert from 'node:assert/strict';
import {publicReviewDecision, publicReviewLimits} from '../scripts/review-quota.mjs';

const now = Date.parse('2026-11-21T12:00:00Z');
const at = minutesAgo => new Date(now - minutesAgo * 60_000).toISOString();
const person = id => ({id, login: `user${id}`, type: 'User'});
const isPublic = user => user?.type === 'User' && user.id !== 1;
// Newest first, as GitHub returns with sort=created&direction=desc.
const pages = rows => { const sorted = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.number - a.number);
  const calls = []; return {calls, list: page => { calls.push(page); return sorted.slice((page - 1) * 100, page * 100); }}; };

test('a burst of public issues reviews only the earliest ones, without any model call for the rest', () => {
  const rows = Array.from({length: 25}, (_, i) => ({number: 100 + i, user: person(10 + i), created_at: at(25 - i)}));
  const {list} = pages(rows);
  const decisions = rows.map(item => publicReviewDecision({request: 'opened', item, actor: item.user, listItems: list, isPublic, now}).allowed);
  assert.deepEqual(decisions, rows.map((_, i) => i < publicReviewLimits.itemsPerDay));
});

test('each public author has a daily bound, and older or maintainer items do not count', () => {
  const author = person(50);
  const rows = [
    ...Array.from({length: 5}, (_, i) => ({number: 200 + i, user: author, created_at: at(50 - i)})),
    ...Array.from({length: 30}, (_, i) => ({number: 300 + i, user: person(1), created_at: at(40 - i)})),
    ...Array.from({length: 30}, (_, i) => ({number: 400 + i, user: person(60 + i), created_at: at(3000 + i)})),
  ];
  const {list} = pages(rows);
  const decisions = rows.slice(0, 5).map(item => publicReviewDecision({request: 'opened', item, actor: author, listItems: list, isPublic, now}).allowed);
  assert.deepEqual(decisions, [true, true, true, false, false]);
  assert.match(publicReviewDecision({request: 'opened', item: rows[4], actor: author, listItems: list, isPublic, now}).reason, /author/);
});

test('a normal public issue is reviewed exactly as before', () => {
  const item = {number: 12, user: person(9), created_at: at(0)};
  const {list, calls} = pages([item, {number: 11, user: person(1), created_at: at(60)}]);
  assert.deepEqual(publicReviewDecision({request: 'opened', item, actor: item.user, listItems: list, isPublic, now}), {allowed: true});
  assert.deepEqual(calls, [1], 'one bounded API page');
});

test('author commands are counted only from runs that reached intake, not surviving comments', () => {
  const author = person(9);
  const decide = (rows, jobs = () => []) => {
    const pages = []; for (let i = 0; i < rows.length || i === 0; i += 100) pages.push(rows.slice(i, i + 100));
    return publicReviewDecision({request: 'command', item: {number: 12, user: author}, actor: author, currentRunId: 1,
      listCommandRuns: page => ({workflow_runs: pages[page - 1] ?? []}), listRunJobs: jobs,
      listItems: () => assert.fail('no list needed'), isPublic, now});
  };
  const current = {id: 1, status: 'in_progress', conclusion: null, created_at: at(0)};
  const done = n => Array.from({length: n}, (_, i) => ({id: 100 + i, status: 'completed', conclusion: 'success', created_at: at(i + 1)}));
  const limit = publicReviewLimits.commandsPerAuthorPerDay;
  assert.equal(decide([current, ...done(limit - 1)]).allowed, true, 'the current request plus earlier ones up to the limit');
  assert.equal(decide([current, ...done(limit)]).allowed, false);
  // 250 ordinary comment events (skipped by the job filter) and an old run never use up requests.
  const ordinary = Array.from({length: 250}, (_, i) => ({id: 1000 + i, status: 'completed', conclusion: 'skipped', created_at: at(1)}));
  assert.equal(decide([current, ...ordinary, ...done(2), {id: 9, status: 'completed', conclusion: 'success', created_at: at(2000)}]).allowed, true);
  // An unfinished run counts unless its intake job was skipped.
  const pending = Array.from({length: limit}, (_, i) => ({id: 500 + i, status: 'in_progress', conclusion: null, created_at: at(1)}));
  assert.equal(decide([current, ...pending], () => [{name: 'intake', conclusion: 'skipped'}]).allowed, true);
  assert.equal(decide([current, ...pending], () => [{name: 'intake', conclusion: null}]).allowed, false);
  assert.equal(decide([current, ...Array.from({length: 21}, (_, i) => ({id: 700 + i, status: 'queued', created_at: at(1)}))]).allowed, false, 'too many unfinished runs fails closed');
  assert.equal(decide(Array.from({length: 300}, (_, i) => ({id: 2000 + i, status: 'completed', conclusion: 'skipped', created_at: at(1)}))).allowed, false, 'beyond the bounded history fails closed');
  assert.throws(() => publicReviewDecision({request: 'command', item: {number: 12, user: author}, actor: author, listCommandRuns: () => ({}), isPublic, now}), /Invalid workflow run/);
});

test('marking a draft ready repeatedly is bounded per item, while the first ready is reviewed', () => {
  const author = person(9);
  const item = {number: 12, user: author, created_at: at(600)};
  const ready = n => Array.from({length: n}, (_, i) => ({event: 'ready_for_review', actor: author, created_at: at(i * 5)}));
  const decide = events => publicReviewDecision({request: 'ready', item, actor: author, listTimeline: () => events,
    listItems: () => [item], isPublic, now});
  assert.equal(decide(ready(1)).allowed, true);
  assert.equal(decide([...ready(publicReviewLimits.readyPerItemPerDay), {event: 'convert_to_draft', actor: author, created_at: at(1)}]).allowed, true);
  assert.equal(decide(ready(publicReviewLimits.readyPerItemPerDay + 1)).allowed, false);
  assert.equal(decide([...ready(1), ...Array.from({length: 5}, () => ({event: 'ready_for_review', actor: author, created_at: at(3000)}))]).allowed, true);
});

test('more items in a day than the bounded listing can show fails closed', () => {
  const rows = Array.from({length: 320}, (_, i) => ({number: 1000 + i, user: person(2000 + i), created_at: at(i)}));
  const {list, calls} = pages(rows);
  const result = publicReviewDecision({request: 'opened', item: rows[0], actor: rows[0].user, listItems: list, isPublic, now});
  assert.equal(result.allowed, false);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.throws(() => publicReviewDecision({request: 'opened', item: rows[0], actor: rows[0].user, listItems: () => ({}), isPublic, now}), /Invalid issue list/);
});
