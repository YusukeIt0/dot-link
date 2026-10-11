import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmRecording } from '../src/audio.ts';
import { selectableTranscriber, sonioxTranscriber, type STTProvider } from '../server/stt.ts';

function recording() {
  const r = new PcmRecording(); r.append(new Uint8Array(new Int16Array(8000).fill(1000).buffer));
  return Buffer.from(r.toWav());
}
class Socket extends EventTarget {
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  closed = false;
  send(data: string | Uint8Array) { this.sent.push(data); }
  close() { this.closed = true; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}
async function session(options: {key?: string; timeoutMs?: number; signal?: AbortSignal} = {}) {
  const socket = new Socket();
  const transcribe = sonioxTranscriber({ key: async () => options.key ?? 'synthetic-test-key', timeoutMs: options.timeoutMs,
    connect: (url, protocols) => {
      assert.equal(url, 'wss://stt-rt.soniox.com/transcribe-websocket');
      assert.deepEqual(protocols, ['soniox-api-key', options.key ?? 'synthetic-test-key']);
      return socket;
    } });
  const result = transcribe(recording(), options.signal);
  await Promise.resolve(); socket.open();
  return {socket, result};
}
test('selection sends only to the selected provider and never falls back on failure', async () => {
  let provider: STTProvider = 'whisper', local = 0, external = 0;
  const run = selectableTranscriber({ selection: async () => provider,
    whisper: async () => { local++; return 'local'; },
    soniox: async () => { external++; throw new Error('synthetic failure'); } });
  assert.equal(await run(recording()), 'local'); assert.equal(external, 0);
  provider = 'soniox'; await assert.rejects(run(recording()), /synthetic failure/);
  assert.equal(local, 1); assert.equal(external, 1);
  provider = 'whisper'; assert.equal(await run(recording()), 'local');
});
test('invalid recording and pre-cancellation never access a key or network', async () => {
  let reads = 0;
  const run = sonioxTranscriber({ key: async () => { reads++; return 'fake'; } });
  await assert.rejects(run(Buffer.alloc(10)));
  await assert.rejects(run(recording(), AbortSignal.abort()), /STT_CANCELLED/);
  assert.equal(reads, 0);
});
test('missing or malformed keys never open a connection', async () => {
  for (const key of [undefined, 'bad\nkey']) {
    const run = sonioxTranscriber({ key: async () => key, connect: () => { assert.fail('network'); } });
    await assert.rejects(run(recording()), /STT_KEY_REQUIRED|STT_AUTH/);
  }
});
test('Soniox consumes final tokens only and waits for explicit completion', async () => {
  const {socket, result} = await session();
  assert.deepEqual(JSON.parse(socket.sent[0] as string), {model: 'stt-rt-v5', audio_format: 'auto'});
  assert.equal(socket.sent.at(-1), '');
  assert.deepEqual(Buffer.concat(socket.sent.filter(x => typeof x !== 'string')), recording());
  socket.message({tokens: [{text:'draft', is_final:false}, {text:'こんにちは', is_final:true}]});
  socket.message({tokens: [{text:'。', is_final:true}, {text:'<end>', is_final:true}], finished:true});
  assert.equal(await result, 'こんにちは。'); assert.equal(socket.closed, true);
});
test('provider errors are bounded codes without provider body or credentials', async () => {
  for (const [error_code, code] of [[401,'STT_AUTH'],[403,'STT_AUTH'],[402,'STT_QUOTA'],[429,'STT_QUOTA'],[503,'STT_UNAVAILABLE']] as const) {
    const {socket,result} = await session();
    const rejection = assert.rejects(result, {message: code});
    socket.message({error_code, error_message:'private content synthetic-test-key'});
    await rejection; assert.equal(socket.closed, true);
  }
});
test('partial transcript is not returned after disconnection or malformed response', async () => {
  for (const mode of ['close','malformed','empty','oversized']) {
    const {socket,result} = await session();
    const rejection = assert.rejects(result, /STT_UNAVAILABLE|STT_INVALID_RESPONSE|STT_NO_TEXT/);
    if (mode === 'close') { socket.message({tokens:[{text:'partial',is_final:true}]}); socket.dispatchEvent(new Event('close')); }
    if (mode === 'malformed') socket.message({tokens:[{text:14,is_final:true}]});
    if (mode === 'empty') socket.message({tokens:[],finished:true});
    if (mode === 'oversized') socket.message({tokens:[{text:'x'.repeat(4001),is_final:true}],finished:true});
    await rejection; assert.equal(socket.closed, true);
  }
});
test('timeout and cancellation close the socket without retry', async () => {
  const timed = await session({timeoutMs:10}); await assert.rejects(timed.result, /STT_TIMEOUT/); assert.equal(timed.socket.closed,true);
  const controller = new AbortController(); const cancelled = await session({signal:controller.signal});
  const rejection = assert.rejects(cancelled.result, /STT_CANCELLED/); controller.abort(); await rejection;
  assert.equal(cancelled.socket.closed,true);
});
test('concurrent recognition is rejected and selection can change after completion', async () => {
  let release!: (text: string) => void;
  const run = selectableTranscriber({selection:async () => 'whisper', whisper:async () => await new Promise<string>(r=>release=r), soniox:async()=>assert.fail()});
  const first=run(recording()); await Promise.resolve();
  await assert.rejects(run(recording()), /STT_BUSY/); release('done'); assert.equal(await first,'done');
});
