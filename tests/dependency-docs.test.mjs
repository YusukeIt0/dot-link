import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = readFileSync('docs/dependencies.md', 'utf8');
const manifest = JSON.parse(readFileSync('scripts/mac-runtime-manifest.json', 'utf8'));
const update = JSON.parse(readFileSync('config/mac-update.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const row = name => {
  const line = doc.split('\n').find(text => text.startsWith(`| ${name} |`));
  assert.ok(line, `missing row ${name}`);
  return line.split('|').map(cell => cell.trim())[2];
};

test('bundled runtime versions in the third-party table match their pins', () => {
  // These change only through reviewed PRs; the table must change with them.
  assert.equal(row('Node.js'), manifest.node.version.replace(/^v/, ''));
  assert.equal(row('whisper.cpp'), manifest.whisper.version.replace(/^v/, ''));
  assert.equal(row('OpenAI tunnel-client'), manifest.tunnel.version.replace(/^v/, ''));
  assert.equal(row('Sparkle'), update.sparkle.version);
});

test('npm dependency rows defer to package.json so Dependabot updates cannot leave stale versions', () => {
  for (const [name, dependency] of [['Even Hub SDK', '@evenrealities/even_hub_sdk'], ['hyparquet', 'hyparquet'],
    ['ipaddr.js', 'ipaddr.js'], ['zod', 'zod'], ['standardwebhooks', 'standardwebhooks']]) {
    assert.ok(pkg.dependencies[dependency], `${dependency} is a direct dependency`);
    assert.equal(row(name), '`package.json` (exact pin)', name);
  }
});
