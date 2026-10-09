import test from 'node:test';
import assert from 'node:assert/strict';
import { originFromStatus, serveState, privateOrigin, launchAgent, tailscale, activateAgent, unloadAgent } from '../scripts/lib/setup.mjs';

test('replacement waits for the old launchd job to disappear before activating its successor', async () => {
  let prints = 0, bootstraps = 0;
  const execute = async (_, args) => {
    if (args[0] === 'print' && ++prints > 2) throw new Error('gone');
    if (args[0] === 'bootstrap') { assert.ok(prints > 2); bootstraps++; }
    return '';
  };
  const dependencies = { execute, wait: async () => {} };
  await unloadAgent('gui/123/local.test', dependencies);
  await activateAgent('gui/123', 'local.test', '/tmp/test.plist', dependencies);
  assert.equal(bootstraps, 1);
});

test('launchd transient release failure retries once, but an existing job is never bootstrapped again', async () => {
  let loaded = false, attempts = 0;
  const execute = async (_, args) => {
    if (args[0] === 'print') { if (!loaded) throw new Error('no job'); return ''; }
    attempts++;
    if (attempts === 1) throw new Error('busy');
    loaded = true; return '';
  };
  await activateAgent('gui/123', 'local.test', '/tmp/test.plist', { execute, wait: async () => {} });
  assert.equal(attempts, 2);
  await activateAgent('gui/123', 'local.test', '/tmp/test.plist', { execute, wait: async () => {} });
  assert.equal(attempts, 2);
});

test('no Tailscale installation is an actionable first-run state, and nonzero login status is readable', async () => {
  await assert.rejects(tailscale({ candidates: ['/definitely-not-installed/tailscale'] }), /インストール/);
  await assert.rejects(tailscale({ candidates: [process.execPath], execute: async () => {
    throw Object.assign(new Error('command failed'), { stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) });
  } }), /ログイン/);
  const calls = [];
  const detected = await tailscale({ candidates: [process.execPath], execute: async (_, args) => {
    calls.push(args);
    return JSON.stringify(args[0] === 'status' ? { BackendState: 'Running', Self: { DNSName: 'other.ts.net.' } } : {});
  } });
  assert.equal(detected.origin, 'https://other.ts.net'); assert.equal(detected.state, 'missing');
  assert.deepEqual(calls, [['status', '--json'], ['serve', 'status', '--json']]);
});

test('setup detects the local Tailscale host and gives distinct first-install actions', () => {
  assert.equal(originFromStatus({ BackendState: 'Running', Self: { DNSName: 'another-mac.some-tailnet.ts.net.' } }), 'https://another-mac.some-tailnet.ts.net');
  for (const [state, message] of [['NeedsLogin', /ログイン/], ['NeedsMachineAuth', /承認/], ['Stopped', /停止/], ['Starting', /起動/]])
    assert.throws(() => originFromStatus({ BackendState: state }), message);
  assert.throws(() => originFromStatus({ BackendState: 'Running', Self: {} }), /MagicDNS/);
  for (const url of ['http://mac.tail.ts.net', 'https://127.0.0.1', 'https://mac.ts.net.evil.test', 'https://key@mac.ts.net', 'https://mac.ts.net/path', 'https://mac.ts.net#key', 'https://mac.ts.net:444'])
    assert.throws(() => privateOrigin(url));
});

test('automatic Serve setup does not replace other apps or accept public Funnel', () => {
  const origin = 'https://mac.tail.ts.net';
  const config = { TCP: { 443: { HTTPS: true } }, Web: { 'mac.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3462' } } } } };
  assert.equal(serveState(config, origin), 'ready');
  assert.equal(serveState({}, origin), 'missing');
  assert.equal(serveState({ ...config, AllowFunnel: { 'mac.tail.ts.net:443': true } }, origin), 'public');
  assert.equal(serveState({ ...config, TCP: { 443: { TCPForward: 'localhost:7777' } } }, origin), 'conflict');
  const other = structuredClone(config); other.Web['mac.tail.ts.net:443'].Handlers['/'].Proxy = 'http://127.0.0.1:7777';
  assert.equal(serveState(other, origin), 'conflict');
  assert.equal(serveState({ Web: { 'old.tail.ts.net:443': {} } }, origin), 'conflict');
});

test('launch agents use selected paths, escape XML, and keep explicit Quit respected', () => {
  const xml = launchAgent('local.test', ['/usr/local/bin/node', '/Users/Other Person/A&B/main.ts'], '/Users/Other Person/A&B', { ORIGIN: 'https://mac.ts.net' });
  assert.match(xml, /\/usr\/local\/bin\/node/); assert.match(xml, /A&amp;B/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  const menu = launchAgent('local.test.menu', ['/app'], '/project', {}, true);
  assert.match(menu, /<key>SuccessfulExit<\/key><false\/>/);
});
