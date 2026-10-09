// Explicitly forward ONE already AX-observed synthetic probe. No UI automation,
// no source-app actions, no arbitrary destination, and no old-test bulk replay.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const probeId = process.argv[2];
if (!/^DOT-LAB-[A-F0-9]{8}$/.test(probeId ?? '')) throw new Error('Specify one DOT-LAB-XXXXXXXX probe ID');
const diagnostic = JSON.parse(await readFile('.runtime/notification-menu/diagnostics.json', 'utf8'));
const probe = diagnostic.probes.find(p => p.id === probeId);
if (!diagnostic.trusted || !diagnostic.observing || diagnostic.paused || !diagnostic.selectedApps.includes('Dot Notification Lab')) throw new Error('Collector must be observing with the test app selected');
if (!probe?.registered || !probe.detectedAt || !probe.bodyMatched || probe.selectedAtDetection !== true) throw new Error('Probe must have an AX title/body match while selected');
if (!/^通知の読み取りテスト \d+。(?:外部への送信はありません|選択・検知後にDotへ自動送信します)。$/.test(probe.body)) throw new Error('Only the fixed synthetic test body is supported');
const key = (await readFile('.runtime/notification-key', 'utf8')).trim();
const deviceKey = (await readFile('.runtime/device-key', 'utf8')).trim();
async function api(path, token, body) {
  const r = await fetch(`http://127.0.0.1:3460${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!r.ok) throw new Error(`Bridge returned HTTP ${r.status}; no success implied`);
  return r.json();
}
if (!(await api('/api/status', deviceKey)).notificationSubscribed) throw new Error('Dot has not subscribed to notification.created; nothing sent');
const hash = createHash('sha256').update(`dot-notification-probe:${probeId}`).digest('hex');
const id = probe.notificationID ?? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
// Preserve the fixed body as observed. Its original local-only text describes
// generation; this separate, explicitly invoked operation forwards it to Dot.
const receipt = await api('/api/notifications', key, { id, source_app: 'Dot Notification Lab', title: probe.id,
  body: probe.body, observed_at: new Date(probe.detectedAt * 1000).toISOString(), source_verification: 'synthetic-test-marker' });
console.log(JSON.stringify({ probeId, notificationId: id, receipt }));
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const entry = (await api('/api/messages', deviceKey)).find(n => n.id === `notification:${id}`);
  if (entry?.reply) {
    const proof = { probeId, notificationId: id, storedForG2: true, announcement: entry.reply, checkedAt: new Date().toISOString() };
    await writeFile('.runtime/notification-roundtrip-proof.json', JSON.stringify(proof, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(proof)); process.exit(0);
  }
  await delay(2000);
}
console.error('No Dot announcement observed before timeout. This is not proof of non-delivery; the same probe ID will not resend.');
process.exitCode = 3;
