import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHOTO_RETENTION } from '../server/photo-attachments.ts';
import { photoFixture } from './photo-fixture.ts';
import { Bridge } from '../server/bridge.ts';
import { bridgeServer } from '../server/http.ts';
import { deviceServer } from '../server/device.ts';
import { WebhookSender } from '../server/webhook.ts';
import { selectableTranscriber, sonioxTranscriber } from '../server/stt.ts';
import { STT_PROVIDERS, type STTProvider } from '../src/stt-providers.ts';
import { PcmRecording } from '../src/audio.ts';

test('typed messages bypass STT, credentials and provider connections even with Soniox selected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-text-route-'));
  const tokens = {mcp: 'a'.repeat(64), device: 'b'.repeat(64)};
  const sender = new WebhookSender(async (_url, body) => {
    const value = JSON.parse(body);
    return {status: 200, body: JSON.stringify(value.type === 'verification' ? {challenge: value.challenge} : {})};
  });
  const bridge = new Bridge(join(directory, 'state.json'), sender, ['callback.example'], undefined, {photoRetention:{...PHOTO_RETENTION,maxBytes:8*1024*1024}});
  const inner = bridgeServer(bridge, tokens);
  inner.listen(0, '127.0.0.1'); await once(inner, 'listening');
  const innerAddress = inner.address(); assert(innerAddress && typeof innerAddress !== 'string');
  let selections = 0, whisperCalls = 0, keyReads = 0, connections = 0;
  const transcribe = selectableTranscriber({
    selection: async () => { selections++; return 'soniox'; },
    whisper: async () => { whisperCalls++; throw new Error('Unexpected Whisper call'); },
    soniox: sonioxTranscriber({
      key: async () => { keyReads++; return undefined; },
      connect: () => { connections++; throw new Error('Unexpected network connection'); },
    }),
  });
  let reportedProvider: STTProvider = 'soniox', statusUnavailable = false;
  const outer = deviceServer({origin: 'https://device.example', directory, token: tokens.device,
    bridgeURL: `http://127.0.0.1:${innerAddress.port}`, transcribe,
    sttProvider: async () => { if (statusUnavailable) throw new Error('Unavailable'); return reportedProvider; }});
  outer.listen(0, '127.0.0.1'); await once(outer, 'listening');
  t.after(async () => {
    for (const server of [outer, inner]) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    await rm(directory, {recursive: true, force: true});
  });
  const address = outer.address(); assert(address && typeof address !== 'string');
  const call = (path: string, method = 'GET', body?: string | Buffer, type = 'application/json') =>
    new Promise<{status: number; body: any}>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${address.port}${path}`, {method, headers: {
        Host: 'device.example', Origin: 'https://device.example', Authorization: `Bearer ${tokens.device}`, 'Content-Type': type,
      }}, res => {
        const chunks: Buffer[] = []; res.on('data', b => chunks.push(b));
        res.on('end', () => resolve({status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString())}));
      });
      req.on('error', reject); req.end(body);
    });
  await bridge.subscribe({name: 'utterance.created', arguments: {session_id: 'personal-g2'}, delivery: {
    mode: 'webhook', url: 'https://callback.example/events', secret: 'whsec_' + randomBytes(32).toString('base64'),
  }});
  const input = {id: randomUUID(), text: 'Typed test: 音声認識を使わず送る文章'};
  assert.equal((await call('/api/utterances', 'POST', JSON.stringify(input))).status, 200);
  assert.equal((await call('/api/messages')).body[0].text, input.text);
  assert.equal((await call('/api/status')).body.sttProvider, 'soniox');
  assert.equal((await call('/api/updates')).body.status.sttProvider, 'soniox');
  reportedProvider = 'whisper';
  assert.equal((await call('/api/updates')).body.status.sttProvider, 'whisper');
  for (const provider of Object.keys(STT_PROVIDERS) as STTProvider[]) {
    reportedProvider = provider;
    const status = (await call('/api/status')).body;
    assert.equal(status.sttProvider,provider); assert.equal(status.sttModel,STT_PROVIDERS[provider].model);
    assert.equal((await call('/api/utterances', 'POST', JSON.stringify({id:randomUUID(),text:'Synthetic typed bypass check'}))).status,200);
  }
  const photos = Array(4).fill(photoFixture(512 * 1024));
  const photoInput = {id: randomUUID(), text: '', photos};
  assert.equal((await call('/api/utterances', 'POST', JSON.stringify(photoInput))).status, 200);
  assert.equal((await call('/api/utterances', 'POST', JSON.stringify(photoInput))).status, 200);
  assert.equal((await call('/api/status')).body.photoAttachments, 1);
  const photoHistory = (await call('/api/messages')).body;
  assert.equal(photoHistory.at(-1).photoCount, 4);
  assert.equal(JSON.stringify(photoHistory).includes(photos[0].data), false);
  const rejected = async (path: string, body: string) => {
    try { assert.equal((await call(path, 'POST', body)).status, 400); }
    catch(error) { assert.equal((error as NodeJS.ErrnoException).code, 'ECONNRESET'); }
  };
  for (let i=0;i<3;i++) assert.equal((await call('/api/utterances','POST',JSON.stringify({...photoInput,id:randomUUID()}))).status,200);
  const full=await call('/api/utterances','POST',JSON.stringify({...photoInput,id:randomUUID()}));
  assert.equal(full.status,422);assert.deepEqual(full.body,{code:'PHOTO_STORAGE_FULL'});
  assert.equal((await call('/api/utterances','POST',JSON.stringify({id:randomUUID(),text:'Text still works'}))).status,200);
  const beforeRejected = bridge.history().length;
  await rejected('/api/utterances', JSON.stringify({...photoInput, id:randomUUID(),photos:[{...photos[0],data:'A'.repeat(3*1024*1024)}]}));
  await rejected('/api/timings', JSON.stringify({padding:'A'.repeat(40000)}));
  assert.equal(bridge.history().length, beforeRejected);
  statusUnavailable = true;
  assert.equal((await call('/api/status')).body.sttProvider, null);
  assert.deepEqual({selections, whisperCalls, keyReads, connections}, {selections: 0, whisperCalls: 0, keyReads: 0, connections: 0});
  // A positive control proves the same server really has the Soniox adapter wired.
  const pcm = new Uint8Array(3200); const view = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length; i += 2) view.setInt16(i, 1000, true);
  const recording = new PcmRecording(); recording.append(pcm);
  const audio = await call('/api/transcribe', 'POST', Buffer.from(recording.toWav()), 'audio/wav');
  assert.equal(audio.status, 422); assert.equal(audio.body.code, 'STT_KEY_REQUIRED');
  assert.deepEqual({selections, whisperCalls, keyReads, connections}, {selections: 1, whisperCalls: 0, keyReads: 1, connections: 0});
});
