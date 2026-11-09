import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {classify, versionOnly, plan, eventRevisions, macPlist, macFeed} from '../scripts/ci-plan.mjs';
import {checkDocs} from '../scripts/check-doc-links.mjs';

const original = '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.tripsurf.dotlink.mac</string><key>CFBundleShortVersionString</key><string>0.4.32</string><key>CFBundleVersion</key><string>111</string><key>DotLinkBeta</key><false/><key>LSMinimumSystemVersion</key><string>13.5</string></dict></plist>';
const next = original.replace('<string>111</string>', '<string>112</string>').replace('<string>0.4.32</string>', '<string>0.4.33</string>');
const file = (path, extra = {}) => ({path, status: 'M', oldMode: '100644', newMode: '100644', ...extra});
const read = revision => revision === 'base' ? original : next;
const protectedPaths = JSON.parse(readFileSync('config/development-policy.json')).protectedPaths;

test('selection composes bounded checks and keeps all other work on macOS', () => {
  for (const [path, check] of [['README.md', 'docs'], ['docs/setup.md', 'docs'], ['site/style.css', 'site'],
    ['site/locales/ja.json', 'site'], [macPlist, 'version'], [macFeed, 'feed']]) {
    assert.deepEqual(classify([file(path)], read, protectedPaths).checks, [check]);
  }
  assert.deepEqual(classify([file('README.md'), file('site/style.css'), file(macFeed)], read, protectedPaths).checks, ['docs', 'feed', 'site']);
  for (const path of ['server/main.ts', 'src/main.ts', 'native/DotLinkSetup/main.swift', 'package.json', 'package-lock.json',
    'app.json', 'tests/site.test.mjs', 'scripts/ci-plan.mjs', 'config/mac-update.json', '.github/workflows/ci.yml', 'docs/development.md', 'unknown.txt']) {
    const result = classify([file('README.md'), file(path)], read, protectedPaths);
    assert.deepEqual(result.checks, ['product'], path);
    assert.equal(result.runner, 'macos-15');
  }
  assert.deepEqual(classify([file(macFeed), file('server/main.ts')], read, protectedPaths).checks, ['product', 'feed']);
});

test('unsafe files, deletions, modes and unbounded comparisons never narrow', () => {
  for (const extra of [{status: 'D'}, {status: 'R'}, {newMode: '120000'}, {newMode: '100755'}, {oldMode: '120000'},
    {path: '../README.md'}, {path: 'docs/a\nb.md'}]) assert.deepEqual(classify([file('README.md', extra)], read).checks, ['product']);
  for (const changes of [[], Array(301).fill(file('README.md'))]) assert.deepEqual(classify(changes, read).checks, ['product']);
});

test('version-only means precisely the two values, never a hidden OS/permission/identity change', () => {
  assert.equal(versionOnly(original, next), true);
  for (const changed of [original, next.replace('112', '110'), next.replace('0.4.33', '0.4.31'), next.replace('13.5', '14.0'),
    next.replace('app.tripsurf.dotlink.mac', 'other.app'), next.replace('<false/>', '<true/>'),
    next.replace('</dict>', '<key>NSMicrophoneUsageDescription</key><string>New access</string></dict>'),
    next.replace('</dict>', '<key>CFBundleVersion</key><string>112</string></dict>'), 'not a plist']) {
    assert.equal(versionOnly(original, changed), false);
    assert.deepEqual(classify([file(macPlist)], r => r === 'base' ? original : changed).checks, ['product']);
  }
});

test('Git comparisons cover complete branch and fail closed without an integrated baseline', t => {
  const root = mkdtempSync(join(tmpdir(), 'dotlink-ci-plan-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  mkdirSync(join(root, 'config')); writeFileSync(join(root, 'config/development-policy.json'), JSON.stringify({protectedPaths}));
  writeFileSync(join(root, 'README.md'), 'before'); git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  writeFileSync(join(root, 'README.md'), 'after'); git('commit', '-am', 'docs'); const docs = git('rev-parse', 'HEAD');
  assert.deepEqual(plan(base, docs, root).checks, ['docs']);
  assert.deepEqual(plan('0'.repeat(40), docs, root).checks, ['product']);
  assert.deepEqual(plan(docs, base, root).checks, ['product']);
  assert.deepEqual(plan(base, 'f'.repeat(40), root).checks, ['product']);
  mkdirSync(join(root, 'server')); writeFileSync(join(root, 'server/code.ts'), 'runtime'); git('add', '.'); git('commit', '-m', 'runtime');
  const parent = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'README.md'), 'child docs'); git('commit', '-am', 'child'); const head = git('rev-parse', 'HEAD');
  assert.deepEqual(plan(base, head, root).checks, ['product']);
  assert.deepEqual(plan(parent, head, root).checks, ['product'], 'Unmerged parent must not certify product coverage');
  git('update-ref', 'refs/remotes/origin/main', parent);
  assert.deepEqual(plan(parent, head, root).checks, ['docs']);
  git('mv', 'README.md', 'renamed.md'); git('commit', '-m', 'rename');
  assert.deepEqual(plan(parent, git('rev-parse', 'HEAD'), root).checks, ['product']);
});

test('event comparison never treats a branch last-push delta as its whole scope', () => {
  assert.deepEqual(eventRevisions('push', {ref: 'refs/heads/feature', before: 'prior', after: 'head'}), {base: null, head: 'head'});
  assert.deepEqual(eventRevisions('push', {ref: 'refs/heads/main', before: 'prior', after: 'head'}), {base: 'prior', head: 'head'});
  assert.deepEqual(eventRevisions('pull_request', {pull_request: {base: {sha: 'base'}, head: {sha: 'head'}}}), {base: 'base', head: 'head'});
});

test('documentation validation catches broken local links, escaping symlinks and conflict markers', t => {
  const root = mkdtempSync(join(tmpdir(), 'dotlink-docs-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const path = join(root, 'guide.md'); writeFileSync(join(root, 'target.md'), 'target');
  writeFileSync(path, '[target](target.md#section) [external](https://example.com)'); checkDocs(['guide.md'], root);
  for (const body of ['[bad](missing.md)', '<<<<<<< conflict\ntext']) {
    writeFileSync(path, body); assert.throws(() => checkDocs(['guide.md'], root));
  }
  symlinkSync(tmpdir(), join(root, 'outside')); writeFileSync(path, '[bad](outside)'); assert.throws(() => checkDocs(['guide.md'], root));
});
