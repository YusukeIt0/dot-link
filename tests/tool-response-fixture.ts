import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../server/bridge.ts';
import { NotificationInbox } from '../server/notifications.ts';
import { LocationContext } from '../server/location.ts';
import { WebhookSender } from '../server/webhook.ts';
import { rpc } from '../server/http.ts';

export async function toolFixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'dot-tool-reasons-'));
  const hosts = ['callback.example.test'];
  const sender = new WebhookSender(async (_url, body) => {
    const event = JSON.parse(body);
    return { status: 200, body: JSON.stringify(event.type === 'verification' ? { challenge: event.challenge } : {}) };
  });
  const bridgePath = join(directory, 'bridge.json');
  const notificationPath = join(directory, 'notifications.json');
  const bridge = new Bridge(bridgePath, sender, hosts);
  const inbox = new NotificationInbox(notificationPath, sender, hosts);
  const location = new LocationContext(join(directory, 'location.json'), sender, hosts,
    (input, guard, context) => bridge.sendMessage(input, guard, context));
  t.after(() => { bridge.close(); location.close(); rmSync(directory, { recursive: true, force: true }); });
  const subscription = { arguments: { session_id: 'personal-g2' },
    delivery: { mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64') } };
  await bridge.subscribe({ ...subscription, name: 'utterance.created' });
  await inbox.subscribe({ ...subscription, name: 'notification.created' });
  const utterance = randomUUID();
  await bridge.submit({ id: utterance, text: 'Synthetic owner input' });
  const notification = async () => {
    const id = randomUUID();
    await inbox.submit({ id, source_app: 'Fixture', title: 'Synthetic notification', body: 'Fixture body',
      observed_at: new Date().toISOString(), source_verification: 'synthetic-test-marker' });
    return id;
  };
  const call = (name: string, args?: unknown) => rpc(bridge,
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args, _meta: { progressToken: 'fixture' } } },
    inbox, location) as Promise<any>;
  return { directory, bridgePath, notificationPath, bridge, inbox, location, sender, hosts, subscription, utterance, notification, call };
}
