import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Bridge } from './bridge.ts';
import { bridgeServer } from './http.ts';
import { safePost, WebhookSender } from './webhook.ts';
import { NotificationInbox } from './notifications.ts';
import { LatencyLog } from './latency.ts';

const tokens = {
  mcp: readFileSync(resolve('.runtime/mcp-key'), 'utf8').trim(),
  device: readFileSync(resolve('.runtime/device-key'), 'utf8').trim(),
  notification: existsSync(resolve('.runtime/notification-key')) ? readFileSync(resolve('.runtime/notification-key'), 'utf8').trim() : undefined,
};
const hosts = (process.env.DOT_CALLBACK_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
// An empty allowlist permits discovery but rejects every callback subscription.
const port = Number(process.env.DOT_BRIDGE_PORT ?? 3460);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const bridge = new Bridge(resolve('.runtime/bridge-state.json'), new WebhookSender(safePost(hosts)), hosts, new LatencyLog(resolve('.runtime/latency-bridge.jsonl')));
const notifications = tokens.notification ? new NotificationInbox(resolve('.runtime/notification-state.json'), new WebhookSender(safePost(hosts)), hosts) : undefined;
const server = bridgeServer(bridge, tokens, notifications);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, '127.0.0.1', () => console.log(`Private Dot bridge listening on 127.0.0.1:${port}; Dot connection not verified`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
