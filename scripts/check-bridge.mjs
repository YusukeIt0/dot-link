import { readFile } from 'node:fs/promises';

const base = `http://127.0.0.1:${process.env.DOT_BRIDGE_PORT ?? 3460}`;
const device = (await readFile('.runtime/device-key', 'utf8')).trim();
const mcp = (await readFile('.runtime/mcp-key', 'utf8')).trim();
const status = await fetch(`${base}/api/status`, {
  headers: { Authorization: `Bearer ${device}` }, signal: AbortSignal.timeout(5000),
});
if (!status.ok) throw new Error(`Bridge status failed: HTTP ${status.status}`);
const state = await status.json();
const discovery = await fetch(`${base}/mcp`, {
  method: 'POST', headers: { Authorization: `Bearer ${mcp}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'check', method: 'server/discover' }),
  signal: AbortSignal.timeout(5000),
});
if (!discovery.ok) throw new Error(`Bridge discovery failed: HTTP ${discovery.status}`);
const metadata = await discovery.json();
if (metadata.error) throw new Error('Bridge discovery returned an error');
console.log(JSON.stringify({
  reachable: true, subscribed: state.subscribed, messageCount: state.messageCount,
  server: metadata.result.serverInfo, versions: metadata.result.supportedVersions,
}));
