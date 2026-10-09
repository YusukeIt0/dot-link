import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const key = (await readFile('.runtime/device-key', 'utf8')).trim();
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:3460${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Bridge request failed: HTTP ${response.status}`);
  return response.json();
}
if (!(await api('/api/status')).subscribed) throw new Error('Dot has not subscribed; test was not sent');
const resumeId = process.argv[2] === '--resume' ? process.argv[3] : undefined;
if (resumeId && !/^[0-9a-f-]{36}$/i.test(resumeId)) throw new Error('Invalid utterance ID');
const id = resumeId ?? randomUUID();
const expected = `G2_DOT_BRIDGE_${id.slice(0, 8)}`;
const message = resumeId ? (await api('/api/messages')).find(item => item.id === id) : await api('/api/utterances', {
  id, text: `これはMac miniからDotへの接続テストです。まだメガネからの送信ではありません。「${expected}」とだけ返信してください。`,
});
if (!message) throw new Error('Existing test utterance was not found');
const startedAt = message.createdAt;
console.log(JSON.stringify({ id, expected, deliveryStatus: message.status }));
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const current = (await api('/api/messages')).find(item => item.id === id);
  if (current?.status === 'replied') {
    const result = { id, expected, startedAt, repliedAt: current.repliedAt, reply: current.reply, exactMatch: current.reply?.trim() === expected };
    await writeFile('.runtime/dot-roundtrip-proof.json', JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
    process.exit(result.exactMatch ? 0 : 2);
  }
  await delay(2000);
}
console.error('Timed out waiting for Dot reply. No duplicate message was sent.');
process.exitCode = 3;
