import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Bridge } from '../server/bridge.ts';
import { WebhookSender } from '../server/webhook.ts';
import { historyFixture, historyScenarios } from '../tests/fixtures/location-history.ts';
import { historyPreviewServer } from '../tests/history-preview-server.ts';

const args = process.argv.slice(2);
const usage = 'Usage: node scripts/history-replay.mjs [--scenario walk|partial|stopped|empty|revoked|no-map] [--reference ISO-INSTANT] [--port 1024..65535] [--check]';
let scenario = 'walk', reference = Date.now(), port = 0, check = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--check') { check = true; continue; }
  if (args[i] === '--help') { console.log(usage); process.exit(0); }
  const value = args[++i];
  if (args[i - 1] === '--scenario' && historyScenarios.includes(value)) scenario = value;
  else if (args[i - 1] === '--reference' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value ?? '') && Number.isFinite(Date.parse(value))) reference = Date.parse(value);
  else if (args[i - 1] === '--port' && /^\d+$/.test(value ?? '') && +value >= 1024 && +value <= 65535) port = +value;
  else throw new Error(usage);
}

const directory = mkdtempSync(join(tmpdir(), 'dot-link-history-preview-'));
const token = randomBytes(32).toString('base64url');
const tokenPath = join(directory, 'mcp-key');
writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
// No callbacks, current device, live-location owner or operational credentials.
const bridge = new Bridge(join(directory, 'empty-bridge.json'), new WebhookSender(async () => { throw new Error('No fixture callbacks'); }), []);
const { history } = historyFixture(scenario, reference);
const server = historyPreviewServer(bridge, token, history);
let cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  server.closeAllConnections(); server.close(); bridge.close(); history.clear();
  rmSync(directory, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(0); });
try {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const call = async (method, params) => {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Preview HTTP check failed');
    const body = await response.json(); if (body.error) throw new Error('Preview RPC check failed'); return body.result;
  };
  const listed = await call('tools/list');
  if (listed.tools.length !== 1 || listed.tools[0].name !== 'get_location_history') throw new Error('Unexpected preview tools');
  const result = await call('tools/call', { name: 'get_location_history', arguments: {} });
  console.log(JSON.stringify({ mode: 'synthetic-read-only', scenario, reference_time: new Date(reference).toISOString(),
    status: result.structuredContent.status, entries: result.structuredContent.entries.length,
    ...(check ? {} : { endpoint: url, credential_file: tokenPath }),
    actual_dot_verified: false, live_location_collection: false }, null, 2));
  if (check) cleanup();
  else console.log('Keep this process open for an isolated test connection. It does not replace the daily relay. Ctrl-C removes fixture state and credential.');
} catch (error) { cleanup(); throw error; }
