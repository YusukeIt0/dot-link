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

test('author re-requests on one item are bounded per day; older requests and other people do not count', () => {
  const author = person(9);
  const command = (id, minutes, user = author, body = '/dotlink review') => ({id, user, body, created_at: at(minutes)});
  const base = [command(1, 2000), command(2, 30, person(8)), command(3, 20, author, 'please /dotlink review')];
  const decide = comments => publicReviewDecision({request: 'command', item: {number: 12, user: author}, actor: author, comments, listItems: () => assert.fail('no list needed'), isPublic, now});
  assert.equal(decide([...base, command(4, 10), command(5, 5), command(6, 1)]).allowed, true);
  assert.equal(decide([...base, command(4, 10), command(5, 5), command(6, 2), command(7, 1)]).allowed, false);
});

test('more items in a day than the bounded listing can show fails closed', () => {
  const rows = Array.from({length: 320}, (_, i) => ({number: 1000 + i, user: person(2000 + i), created_at: at(i)}));
  const {list, calls} = pages(rows);
  const result = publicReviewDecision({request: 'opened', item: rows[0], actor: rows[0].user, listItems: list, isPublic, now});
  assert.equal(result.allowed, false);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.throws(() => publicReviewDecision({request: 'opened', item: rows[0], actor: rows[0].user, listItems: () => ({}), isPublic, now}), /Invalid issue list/);
});
