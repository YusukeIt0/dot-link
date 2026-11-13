import { HealthContext } from './health/context.ts';
import { healthKeychain } from './health/vault.ts';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WeatherContext } from './weather/context.ts';
import { WeatherService } from './weather/service.ts';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Bridge } from './bridge.ts';
import { bridgeServer } from './http.ts';
import { safePost, WebhookSender } from './webhook.ts';
import { NotificationInbox } from './notifications.ts';
import { LatencyLog } from './latency.ts';
import { LocationContext } from './location.ts';
import { MobilityAcquisition } from './mobility/context.ts';
import { LocalGeography } from './geography/loader.ts';
import { PairingAuthority } from './pairing-authority.ts';
import { LocationHistoryStore } from './history/store.ts';
import { createHash } from 'node:crypto';
import { SharingActivation } from './sharing-activation.ts';

try {writeFileSync(resolve('.runtime/health-admin-key'),randomBytes(32).toString('base64url'),{flag:'wx',mode:0o600});} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
const tokens = {
  healthAdmin: readFileSync(resolve('.runtime/health-admin-key'),'utf8').trim(),
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
const pairing = new PairingAuthority(resolve('.runtime/pairing'));
const legacyLocationOwner = createHash('sha256').update(tokens.device).digest('hex');
let history: LocationHistoryStore | undefined;
try {
  history = new LocationHistoryStore(resolve('.runtime/location-history'), {
    ownerAuthorized: owner => owner === legacyLocationOwner || pairing.authorizedSubject(owner),
    ownerRevoked: owner => owner !== legacyLocationOwner && pairing.subjectStatus(owner) === 'revoked',
    announce: (input, guard) => bridge.sendMessage(input, guard),
  });
} catch { console.error('Location history unavailable; ordinary conversation remains available'); }
const locations = new LocationContext(resolve('.runtime/location-subscription.json'), new WebhookSender(safePost(hosts)), hosts,
  (input, guard, context) => bridge.sendMessage(input, guard, context), Date.now,
  owner => owner === legacyLocationOwner || pairing.authorizedSubject(owner),
  output=>new LocalGeography(resolve('.runtime/geography'),output),()=>new MobilityAcquisition(), {attachGeography: (fix, evidence, owner) => history?.attachGeography(fix, evidence, owner)});
let weather: WeatherContext | undefined;
try {
  weather = new WeatherContext(resolve('.runtime/weather-consent.json'),
    new WeatherService(resolve('.runtime/weather-cache.json')), locations,
    {ownerAuthorized: owner => owner === legacyLocationOwner || pairing.authorizedSubject(owner),
      ownerRevoked: owner => owner !== legacyLocationOwner && pairing.subjectStatus(owner) === 'revoked'});
} catch { console.error('Weather unavailable; ordinary conversation remains available'); }
const health = new HealthContext(resolve('.runtime/health/state.enc'), {
  key: healthKeychain(process.env.DOT_LINK_APP_RUNTIME === '1' ? fileURLToPath(new URL('../../../MacOS/DotLink',import.meta.url)) : undefined),
  ownerAuthorized: owner => owner === legacyLocationOwner || pairing.authorizedSubject(owner),
  ownerRevoked: owner => owner !== legacyLocationOwner && pairing.subjectStatus(owner) === 'revoked',
  announce: (input,guard) => bridge.sendMessage(input,guard), sender: new WebhookSender(safePost(hosts)),hosts,
});
const activation: SharingActivation[] = [];
try {activation.push(new SharingActivation(resolve('.runtime/health-sharing-activation.json'),bridge,health,Date.now,'health'));}
catch {console.error('Health activation unavailable; ordinary conversation remains available');}
try { activation.push(new SharingActivation(resolve('.runtime/sharing-activation.json'), bridge, locations)); }
catch { console.error('Sharing activation unavailable; ordinary conversation remains available'); }
if (notifications) {
  try { activation.push(new SharingActivation(resolve('.runtime/notification-sharing-activation.json'), bridge, notifications, Date.now, 'notification')); }
  catch { console.error('Notification activation unavailable; ordinary conversation remains available'); }
}
const server = bridgeServer(bridge, tokens, notifications, locations, history, weather, activation, health);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, '127.0.0.1', () => console.log(`Private Dot bridge listening on 127.0.0.1:${port}; Dot connection not verified`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {weather?.close();history?.close();locations.close();server.close(() => process.exit(0));});
