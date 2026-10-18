import test from 'node:test';
import assert from 'node:assert/strict';
import {notifyGrokReview} from '../scripts/notify-grok-review.mjs';
import {selectPR} from '../scripts/select-grok-reviews.mjs';
import {grokBlockers} from '../scripts/grok-review.mjs';
const payload = {repo: 'YusukeIt0/dot-link', pr: 88, head_sha: 'a'.repeat(40)};
const env = {GROK_REVIEW_WEBHOOK_URL: 'https://example.invalid/secret-route', GROK_REVIEW_WEBHOOK_KEY: 'test-secret'};

test('one bounded POST sends only approved fields with the exact authorization value', async () => {
  const calls = [], warnings = [];
  await notifyGrokReview({...payload, body: 'private comment', review: 'private review'}, {
    env, warn: x => warnings.push(x), fetchImpl: async (...args) => {calls.push(args); return new Response(null, {status: 204});},
  });
  assert.equal(calls.length, 1);
  const [url, request] = calls[0];
  assert.equal(String(url), env.GROK_REVIEW_WEBHOOK_URL);
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, env.GROK_REVIEW_WEBHOOK_KEY);
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.body), payload); assert.deepEqual(warnings, []);
});

test('missing secrets or insecure endpoints warn without sending', async () => {
  for (const config of [{}, {GROK_REVIEW_WEBHOOK_URL: env.GROK_REVIEW_WEBHOOK_URL},
    {GROK_REVIEW_WEBHOOK_KEY: env.GROK_REVIEW_WEBHOOK_KEY},
    {...env, GROK_REVIEW_WEBHOOK_URL: 'http://example.invalid'}, {...env, GROK_REVIEW_WEBHOOK_URL: 'not-a-url'}]) {
    const warnings = []; let sends = 0;
    await notifyGrokReview(payload, {env: config, warn: x => warnings.push(x), fetchImpl: async () => {sends++;}});
    assert.equal(sends, 0); assert.equal(warnings.length, 1);
  }
});

test('failed delivery never retries, exposes secrets, fails selection or releases the hold', async () => {
  for (const transport of [async () => new Response('private body', {status: 500}),
    async () => new Response(null, {status: 302}),
    async () => {throw new Error(`${env.GROK_REVIEW_WEBHOOK_URL} ${env.GROK_REVIEW_WEBHOOK_KEY}`);},
    async () => {throw new DOMException('timeout', 'TimeoutError');}]) {
    const pr = {state: 'open', head: {sha: payload.head_sha}, labels: ['bug', 'P1']};
    let sends = 0; const warnings = [];
    const notify = data => notifyGrokReview(data, {env, warn: x => warnings.push(x), fetchImpl: async (...args) => {sends++; return transport(...args);}});
    const client = {
      api: () => structuredClone(pr),
      graphql: () => ({data: {repository: {pullRequest: {headRefOid: payload.head_sha, closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}}}),
      addLabel: (_, label) => pr.labels.push(label),
    };
    assert.equal((await selectPR(payload.pr, client, true, notify)).action, 'labeled');
    assert.ok(pr.labels.includes('independent-review'));
    assert.equal(grokBlockers(pr, []).length, 1);
    assert.equal((await selectPR(payload.pr, client, true, notify)).action, 'unchanged');
    assert.equal(sends, 1); assert.equal(warnings.length, 1);
    assert.ok(!warnings.join().includes('secret')); assert.ok(!warnings.join().includes('private body'));
  }
});

test('workflow receives child PR events, has no timer, and keeps trusted-main execution', async () => {
  const {readFileSync} = await import('node:fs');
  const workflow = readFileSync(new URL('../.github/workflows/grok-review-selection.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /^\s*(schedule|cron):/m);
  assert.match(workflow, /types: \[opened, reopened, edited, synchronize, labeled, unlabeled\]/);
  assert.match(workflow, /issues:\n\s+types: \[edited, labeled, unlabeled\]/);
  assert.doesNotMatch(workflow, /pull_request\.base\.ref/);
  assert.match(workflow, /ref: main\n\s+persist-credentials: false/);
  assert.match(workflow, /REVIEW_HEAD_CHANGED:.*pull_request_target.*synchronize/);
});
