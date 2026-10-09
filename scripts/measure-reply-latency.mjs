// Sends real, clearly identified Codex diagnostics to the existing Dot.
// Run on the deployed Mac. Output contains timings/IDs, never conversation text.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const base = new URL(process.argv[2] ?? '');
if (base.protocol !== 'https:' || !base.hostname.endsWith('.ts.net') || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('Use the configured private Tailscale HTTPS origin');
const count = Number(process.argv[3] ?? 3);
if (!Number.isInteger(count) || count < 1 || count > 5) throw Error('Choose 1–5 diagnostic messages');
const audio = process.argv[4] ? await readFile(process.argv[4]) : undefined;
const key = (await readFile('.runtime/device-key', 'utf8')).trim();
async function api(path, { body, revision, signal, trace } = {}) {
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': body instanceof Uint8Array ? 'audio/wav' : 'application/json', ...(trace ? { 'X-G2-Trace-ID': trace } : {}), ...(revision ? { 'X-G2-Revision': revision } : {}) },
    ...(body ? { body: (body instanceof Uint8Array ? body : JSON.stringify(body)) } : {}), redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
  });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  return response.json();
}
let snapshot = await api('/api/updates');
if (!snapshot.status.subscribed) throw Error('No active Dot subscription; nothing sent');
const results = [];
for (let index = 0; index < count; index++) {
  const id = randomUUID(), expected = `速度計測${index + 1}完了`;
  const stop = new AbortController(), deadline = setTimeout(() => stop.abort(), 300000);
  const observe = async (live) => {
    let revision = snapshot.revision;
    while (!stop.signal.aborted) {
      let messages;
      if (live) { const next = await api('/api/updates', { revision, signal: stop.signal }); revision = next.revision; messages = next.messages; }
      else { await delay(3000, undefined, { signal: stop.signal }); await api('/api/status', { signal: stop.signal }); messages = await api('/api/messages', { signal: stop.signal }); }
      const reply = messages.find(m => m.id === id && m.repliedAt);
      if (reply) return { receivedAt: Date.now(), storedAt: Date.parse(reply.repliedAt), exactMatch: reply.reply.trim() === expected };
    }
  };
  // Attach handlers before sending, so an early failure cannot be unhandled.
  const observers = Promise.allSettled([observe(true), observe(false)]);
  const result = { id, index: index + 1, status: 'starting', measurement: 'same Mac clock; HTTPS device endpoint; no physical G2' };
  results.push(result);
  await writeFile('.runtime/latency-comparison.json', JSON.stringify(results, null, 2), { mode: 0o600 });
  try {
    const start = Date.now();
    const recognized = audio ? await api('/api/transcribe', { body: audio, trace: id }) : undefined;
    if (audio) result.asrRequestMs = Date.now() - start;
    const postStart = Date.now();
    const sent = await api('/api/utterances', { body: { id, text: `AIエージェントCodexから、本人が依頼したG2応答時間改善の計測です。本人の発話やG2マイク入力ではありません。通常のreply_to_g2でこの発話へ「${expected}」とだけ返信してください。追加調査・待機・自発連絡は不要です。${recognized ? `以下は合成音声をWhisperで認識したテスト文です: ${recognized.text}` : ''}` } });
    result.postMs = Date.now() - postStart; result.status = sent.status;
    console.log(JSON.stringify({ id, index: index + 1, phase: 'submitted', postMs: result.postMs }));
    const [live, polling] = await observers;
    if (live.status !== 'fulfilled' || polling.status !== 'fulfilled' || !live.value || !polling.value) throw Error('Observation incomplete; no message was resent');
    Object.assign(result, { status: 'replied', syntheticAudio: !!audio, totalLiveMs: live.value.receivedAt - start, totalPollingMs: polling.value.receivedAt - start, bridgeReplyMs: live.value.storedAt - Date.parse(sent.createdAt), liveDeliveryMs: live.value.receivedAt - live.value.storedAt,
      pollingDeliveryMs: polling.value.receivedAt - polling.value.storedAt, savedMs: polling.value.receivedAt - live.value.receivedAt, exactMatch: live.value.exactMatch && polling.value.exactMatch });
    const rows = (await readFile('.runtime/latency-bridge.jsonl', 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.id === id);
    const at = stage => rows.find(row => row.stage === stage)?.at;
    const elapsed = (from, to) => at(from) !== undefined && at(to) !== undefined ? at(to) - at(from) : null;
    result.stages = { webhookMs: elapsed('webhook_sent', 'webhook_accepted'), acceptedToReadMs: elapsed('webhook_accepted', 'dot_pending_read'), readToReplyMs: elapsed('dot_pending_read', 'dot_reply_received'), saveMs: elapsed('dot_reply_received', 'reply_stored') };
  } catch (error) { result.status = 'incomplete'; result.error = error.message; }
  finally { clearTimeout(deadline); stop.abort(); await observers; }
  await writeFile('.runtime/latency-comparison.json', JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
  if (result.status !== 'replied' || !result.exactMatch) { process.exitCode = 3; break; }
  snapshot = await api('/api/updates');
}
