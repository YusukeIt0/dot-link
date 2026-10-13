import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const script = resolve('scripts/claude-review.mjs');
const base = 'a'.repeat(40), head = 'b'.repeat(40);
const pr = {number: 12, title: 'History fix', body: 'Restore saved messages', state: 'open',
  draft: false, changed_files: 1, base: {ref: 'main', sha: base},
  head: {sha: head, repo: {full_name: 'YusukeIt0/dot-link'}}};
const result = {summary: 'Review complete', findings: [{severity: 'medium', file: 'src/main.ts',
  line: 7, title: 'Missing state', reason: 'A concrete condition'}], limitations: 'Static review only'};

function run(mode, {pull = pr, review = result, env = {}, diff = '+new line\n'} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dot-review-test-'));
  try {
    writeFileSync(join(directory, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const fixture = JSON.parse(process.env.REVIEW_FIXTURE);
if(a.includes('--input')) {
  fs.writeFileSync('posted.json', fs.readFileSync(0));
  console.log(JSON.stringify({html_url:'https://github.com/YusukeIt0/dot-link/pull/12#review'}));
} else if(a.includes('Accept: application/vnd.github.diff')) process.stdout.write(fixture.diff);
else if(a[1].includes('/commits/')) console.log(fixture.base);
else if(a[1].includes('/files?')) console.log(JSON.stringify([{filename:'src/main.ts'}]));
else console.log(JSON.stringify(fixture.pull));
`, {mode: 0o700});
    const output = spawnSync(process.execPath, [script, mode], {cwd: directory, encoding: 'utf8',
      env: {...process.env, PATH: directory + ':' + process.env.PATH,
        GITHUB_REPOSITORY: 'YusukeIt0/dot-link', PR_NUMBER: '12', GITHUB_SHA: base,
        GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary'),
        REVIEW_HEAD_SHA: head, REVIEW_JSON: JSON.stringify(review),
        REVIEW_FIXTURE: JSON.stringify({pull, diff, base}), ...env}});
    const content = name => existsSync(join(directory, name)) ? readFileSync(join(directory, name), 'utf8') : null;
    return {status: output.status, error: output.stderr, posted: content('posted.json'),
      prepared: content('.review/input.md'), output: content('output')};
  } finally { rmSync(directory, {recursive: true, force: true}); }
}

test('prepares a pinned same-repository PR without posting', () => {
  const r = run('prepare'); assert.equal(r.status, 0, r.error);
  assert.match(r.prepared, /History fix/); assert.equal(r.output, `head_sha=${head}\n`);
  assert.equal(r.posted, null);
});
test('rejects draft, closed, fork and wrong-base PRs', () => {
  for (const pull of [{...pr, draft: true}, {...pr, state: 'closed'},
    {...pr, head: {...pr.head, repo: {full_name: 'someone/fork'}}},
    {...pr, base: {...pr.base, ref: 'other'}}]) {
    const r = run('prepare', {pull}); assert.notEqual(r.status, 0); assert.equal(r.posted, null);
  }
});
test('rejects invalid PR identifiers and stale main', () => {
  for (const env of [{PR_NUMBER: '12;echo injected'}, {GITHUB_REPOSITORY: 'someone/other'}]) {
    assert.notEqual(run('prepare', {env}).status, 0);
  }
  assert.notEqual(run('prepare', {pull: {...pr, base: {...pr.base, sha: 'c'.repeat(40)}}}).status, 0);
});
test('rejects empty changes and too many changed files', () => {
  assert.notEqual(run('prepare', {diff: ''}).status, 0);
  assert.notEqual(run('prepare', {pull: {...pr, changed_files: 51}}).status, 0);
});
test('posts only a COMMENT review tied to the inspected commit', () => {
  const r = run('report'); assert.equal(r.status, 0, r.error);
  const posted = JSON.parse(r.posted); assert.equal(posted.commit_id, head);
  assert.equal(posted.event, 'COMMENT'); assert.match(posted.body, /src\/main.ts:7/);
});
test('does not publish stale or invalid findings', () => {
  const stale = run('report', {pull: {...pr, head: {...pr.head, sha: 'c'.repeat(40)}}});
  assert.notEqual(stale.status, 0); assert.equal(stale.posted, null);
  const invalid = run('report', {review: {...result, findings: [{...result.findings[0], file: '.env'}]}});
  assert.notEqual(invalid.status, 0); assert.equal(invalid.posted, null);
});
