import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {classify, versionOnly, packageVersionOnly, packageFiles, plan, eventRevisions, macPlist, macFeed} from '../scripts/ci-plan.mjs';
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

test('Markdown notes beside README/film assets run docs checks; nearby files keep their scope', () => {
  for (const change of [file('assets/readme/README.md'), file('assets/film/x.md'), file('assets/film/x.md', {status: 'A', oldMode: '000000'})]) {
    const result = classify([change], read, protectedPaths);
    assert.deepEqual([result.checks, result.runner], [['docs'], 'ubuntu-latest'], change.path);
  }
  assert.deepEqual(classify([file('assets/readme/README.md'), file('assets/readme/conversation-en.png')], read, protectedPaths).checks, ['docs', 'site']);
  assert.deepEqual(classify([file('assets/readme/README.md'), file('src/main.ts')], read, protectedPaths).checks, ['product']);
  for (const path of ['assets/readme/sub/x.md', 'assets/readme/notes.txt', 'assets/film/notes.markdown', 'assets/film/x.MD',
    'assets/brand/x.md', 'assets/x.md', 'assets/readme.md']) assert.deepEqual(classify([file(path)], read, protectedPaths).checks, ['product'], path);
  for (const extra of [{status: 'D'}, {status: 'R'}, {newMode: '100755'}, {newMode: '120000'}, {oldMode: '120000'}]) {
    assert.deepEqual(classify([file('assets/readme/README.md', extra)], read, protectedPaths).checks, ['product'], JSON.stringify(extra));
  }
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

// Real current metadata as the base; heads change only what each case names.
const packageBase = Object.fromEntries(packageFiles.map(path => [path, JSON.parse(readFileSync(path, 'utf8'))]));
const bump = version => version.replace(/\d+$/, n => String(+n + 1));
const packageHead = (change = () => {}, version = bump(packageBase['app.json'].version)) => {
  const files = structuredClone(packageBase), lock = files['package-lock.json'];
  files['app.json'].version = files['package.json'].version = lock.version = lock.packages[''].version = version;
  change(files);
  return files;
};
const text = value => typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
const packageRead = head => (revision, path) => path === macPlist ? read(revision) : text((revision === 'base' ? packageBase : head)[path]);

test('package version-only means one matching increasing version and no other metadata change', () => {
  assert.equal(packageVersionOnly(packageRead(packageHead())), true);
  const [major, minor] = packageBase['app.json'].version.split('.').map(Number);
  assert.equal(packageVersionOnly(packageRead(packageHead(() => {}, `${major}.${minor + 1}.0`))), true);
  const lockEntry = Object.keys(packageBase['package-lock.json'].packages).find(key => key);
  for (const change of [
    f => f['package.json'].dependencies[Object.keys(f['package.json'].dependencies)[0]] = '9.9.9',
    f => f['package.json'].devDependencies[Object.keys(f['package.json'].devDependencies)[0]] = '9.9.9',
    f => f['package.json'].scripts.test = 'true', f => f['package.json'].name = 'other',
    f => f['app.json'].permissions.push({name: 'camera', desc: 'New access', whitelist: []}),
    f => f['app.json'].min_sdk_version = '9.9.9', f => f['app.json'].package_id = 'app.other',
    f => f['package-lock.json'].packages[lockEntry].version = '9.9.9',
    f => f['app.json'].version = packageBase['app.json'].version,
    f => f['package-lock.json'].version = packageBase['app.json'].version,
    f => f['package-lock.json'].packages[''].version = packageBase['app.json'].version,
    f => delete f['package-lock.json'].packages[''], f => f['package.json'] = 'invalid',
    f => f['package.json'] = {private: f['package.json'].private, ...f['package.json']},
  ]) assert.equal(packageVersionOnly(packageRead(packageHead(change))), false, change.toString());
  for (const version of [packageBase['app.json'].version, '0.0.1', `${packageBase['app.json'].version}-beta`, '1.2', '12345.0.0']) {
    assert.equal(packageVersionOnly(packageRead(packageHead(() => {}, version))), false, version);
  }
  assert.equal(packageVersionOnly(() => { throw new Error('Missing file'); }), false);
});

test('release metadata selects package-version alone or with docs and Mac version checks', () => {
  const json = packageFiles.map(path => file(path));
  for (const changes of [json, [...json].reverse()]) {
    const result = classify(changes, packageRead(packageHead()), protectedPaths);
    assert.deepEqual([result.checks, result.runner], [['package-version'], 'ubuntu-latest']);
  }
  // #352 shape: Even/package versions, Mac plist versions and release documentation.
  const release = [...json, file(macPlist), file('docs/privacy.md'), file('docs/even-release-notes.md')];
  assert.deepEqual(classify(release, packageRead(packageHead()), protectedPaths).checks, ['docs', 'package-version', 'version']);
  const lone = packageRead({...packageBase, 'package.json': packageHead()['package.json']});
  assert.deepEqual(classify([file('package.json')], lone, protectedPaths).checks, ['product']);
  assert.deepEqual(classify([...json, file('src/main.ts')], packageRead(packageHead()), protectedPaths).checks, ['product']);
  assert.deepEqual(classify(json, packageRead(packageHead(f => f['package.json'].scripts.test = 'true')), protectedPaths).checks, ['product']);
  for (const extra of [{status: 'A', oldMode: '000000'}, {status: 'D'}, {newMode: '100755'}]) {
    assert.deepEqual(classify([file('app.json', extra), ...json.slice(1)], packageRead(packageHead()), protectedPaths).checks, ['product']);
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

test('an asset-note-only comparison plans docs from Git, while deleting the note keeps full scope', t => {
  const root = mkdtempSync(join(tmpdir(), 'dotlink-ci-plan-note-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  mkdirSync(join(root, 'config')); writeFileSync(join(root, 'config/development-policy.json'), JSON.stringify({protectedPaths}));
  mkdirSync(join(root, 'assets/readme'), {recursive: true}); writeFileSync(join(root, 'assets/readme/README.md'), 'before');
  git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  writeFileSync(join(root, 'assets/readme/README.md'), 'after'); git('commit', '-am', 'note');
  const note = plan(base, git('rev-parse', 'HEAD'), root);
  assert.deepEqual([note.checks, note.runner, note.paths], [['docs'], 'ubuntu-latest', ['assets/readme/README.md']]);
  git('rm', '-q', 'assets/readme/README.md'); git('commit', '-m', 'delete');
  assert.deepEqual(plan(base, git('rev-parse', 'HEAD'), root).checks, ['product']);
});

test('an Even-only version bump plans and passes the CI runner without any Mac plist', t => {
  const root = mkdtempSync(join(tmpdir(), 'dotlink-ci-plan-package-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
  const write = files => { for (const path of packageFiles) writeFileSync(join(root, path), text(files[path])); };
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  mkdirSync(join(root, 'config')); writeFileSync(join(root, 'config/development-policy.json'), JSON.stringify({protectedPaths}));
  write(packageBase); git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  write(packageHead()); git('commit', '-am', 'version'); const head = git('rev-parse', 'HEAD');
  const selected = plan(base, head, root);
  assert.deepEqual([selected.checks, selected.runner], [['package-version'], 'ubuntu-latest']);
  const env = {...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '', CI_REUSE_RUN: ''};
  const output = execFileSync(process.execPath, [join(process.cwd(), 'scripts/run-ci-plan.mjs'), base, head], {cwd: root, encoding: 'utf8', env});
  assert.match(output, /Package metadata verified: one matching increased version/);
  assert.match(output, /Validation passed: package-version in/);
  // Revalidation fails closed when the compared base does not show an increase.
  const release = pathToFileURL(join(process.cwd(), 'scripts/check-release-metadata.mjs')).href;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {checkRelease} from ${JSON.stringify(release)}; await checkRelease('package-version', ${JSON.stringify(head)});`], {cwd: root, stdio: 'pipe', env}));
  write(packageHead(f => f['package.json'].scripts.test = 'true')); git('commit', '-am', 'script');
  assert.deepEqual(plan(base, git('rev-parse', 'HEAD'), root).checks, ['product']);
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

test('documentation validation resolves an asset note from its own folder without the root README rule', t => {
  const root = mkdtempSync(join(tmpdir(), 'dotlink-docs-note-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'assets/readme'), {recursive: true});
  writeFileSync(join(root, 'README.md'), 'root'); writeFileSync(join(root, 'assets/readme/sample.png'), '');
  const note = 'assets/readme/README.md', path = join(root, note);
  writeFileSync(path, '![sample](sample.png) [home](../../README.md)'); checkDocs([note], root);
  for (const body of ['![sample](assets/readme/sample.png)', '[outside](../../../outside.md)', '>>>>>>> conflict']) {
    writeFileSync(path, body); assert.throws(() => checkDocs([note], root), body);
  }
});
