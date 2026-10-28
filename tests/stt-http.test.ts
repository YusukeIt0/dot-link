import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmRecording } from '../src/audio.ts';
import { httpTranscriber, microsoftEndpoint, type HTTPSTTProvider } from '../server/stt-http.ts';
import { STT_PROVIDERS } from '../src/stt-providers.ts';
import { selectableTranscriber } from '../server/stt.ts';

function recording() {
  const r = new PcmRecording(); r.append(new Uint8Array(new Int16Array(8000).fill(1000).buffer));
  return Buffer.from(r.toWav());
}
const providers = ['elevenlabs', 'microsoft', 'openai', 'assemblyai'] as const;
const endpoint = async () => 'https://test-resource.cognitiveservices.azure.com';
function request(provider: HTTPSTTProvider, response: () => Promise<Response>) {
  return httpTranscriber(provider, {key:async ()=>'synthetic-key', endpoint, fetch:async () => response()});
}
for (const provider of providers) {
  test(`${provider}: sends one recording to its own API with the declared model and auth`, async () => {
    let calls = 0;
    const run = httpTranscriber(provider, {key:async ()=>'synthetic-key', endpoint, fetch:async (input, init) => {
      calls++;
      assert.equal(init?.redirect,'error'); assert.equal(init?.method,'POST');
      const url = new URL(String(input)); const headers = new Headers(init?.headers);
      const form = init?.body as FormData;
      assert.ok(form instanceof FormData);
      const audio = form.get(provider === 'microsoft' || provider === 'assemblyai' ? 'audio' : 'file') as File;
      assert.equal(audio.type,'audio/wav'); assert.deepEqual(Buffer.from(await audio.arrayBuffer()),recording());
      const expected = {
        elevenlabs:['api.elevenlabs.io','/v1/speech-to-text','xi-api-key','synthetic-key'],
        microsoft:['test-resource.cognitiveservices.azure.com','/speechtotext/transcriptions:transcribe','Ocp-Apim-Subscription-Key','synthetic-key'],
        openai:['api.openai.com','/v1/audio/transcriptions','Authorization','Bearer synthetic-key'],
        assemblyai:['sync.assemblyai.com','/v1/transcribe','Authorization','synthetic-key'],
      }[provider];
      assert.equal(url.hostname,expected[0]); assert.equal(url.pathname,expected[1]); assert.equal(headers.get(expected[2]),expected[3]);
      assert.equal(String(input).includes('synthetic-key'),false);
      if (provider === 'microsoft') {
        assert.equal(url.searchParams.get('api-version'),'2025-10-15');
        assert.deepEqual(JSON.parse(form.get('definition') as string), {enhancedMode:{enabled:true,model:'MAI-Transcribe-2'}});
        return Response.json({combinedPhrases:[{text:'Hello'},{text:'world.'}]});
      }
      if (provider === 'assemblyai') assert.equal(headers.get('X-AAI-Model'),'universal-3-5-pro');
      else assert.equal(form.get(provider === 'elevenlabs' ? 'model_id' : 'model'),STT_PROVIDERS[provider].model);
      return Response.json({text:' Hello world. '});
    }});
    assert.equal(await run(recording()),'Hello world.'); assert.equal(calls,1);
  });
}
test('all added providers route independently and never fall back when selected API fails', async () => {
  for (const provider of providers) {
    let calls = 0;
    const fail = async () => { assert.fail('wrong provider'); };
    const run = selectableTranscriber({ speech: async () => true,selection:async()=>provider,whisper:fail,soniox:fail,
      providers:Object.fromEntries(providers.map(p=>[p,p===provider ? async()=>{calls++;throw new Error('selected failed');} : fail]))});
    await assert.rejects(run(recording()),/selected failed/); assert.equal(calls,1);
  }
});
test('Azure accepts only a resource HTTPS origin before reading any key', async () => {
  assert.equal(microsoftEndpoint('https://test.cognitiveservices.azure.com/'),'https://test.cognitiveservices.azure.com');
  for (const bad of ['',undefined,'http://test.cognitiveservices.azure.com','https://example.com',
    'https://test.cognitiveservices.azure.com.evil.test','https://user:password@test.cognitiveservices.azure.com',
    'https://test.cognitiveservices.azure.com/path','https://test.cognitiveservices.azure.com?key=secret',
    'https://test.cognitiveservices.azure.com#fragment','https://test.cognitiveservices.azure.com:8443','https://127.0.0.1']) {
    assert.throws(()=>microsoftEndpoint(bad), /STT_CONFIG_REQUIRED/);
    const run=httpTranscriber('microsoft',{key:async()=>assert.fail('key read'),endpoint:async()=>bad as string});
    await assert.rejects(run(recording()),/STT_CONFIG_REQUIRED/);
  }
});
test('missing keys, invalid audio and cancellation do not contact a provider', async () => {
  for (const provider of providers) {
    let reads=0;
    const run=httpTranscriber(provider,{key:async()=>{reads++;return undefined;},endpoint,fetch:async()=>assert.fail('network')});
    await assert.rejects(run(Buffer.alloc(10))); await assert.rejects(run(recording(),AbortSignal.abort()),/STT_CANCELLED/);
    assert.equal(reads,0); await assert.rejects(run(recording()),/STT_KEY_REQUIRED/);
  }
});
test('HTTP failures never expose provider bodies, keys or transcripts, or retry', async () => {
  for (const provider of providers) for (const [status,code] of [[401,'STT_AUTH'],[403,'STT_AUTH'],[402,'STT_QUOTA'],[429,'STT_QUOTA'],[500,'STT_UNAVAILABLE']] as const) {
    let calls=0;
    await assert.rejects(request(provider,async()=>{calls++;return new Response('synthetic secret and transcript',{status});})(recording()),{message:code});
    assert.equal(calls,1);
  }
});
test('invalid, oversized and empty transcripts are bounded failures', async () => {
  for (const provider of providers) {
    for (const text of [null,42,'x'.repeat(4001)]) {
      const body=provider==='microsoft'?{combinedPhrases:[{text}]}:{text};
      await assert.rejects(request(provider,async()=>Response.json(body))(recording()),/STT_INVALID_RESPONSE/);
    }
    const body=provider==='microsoft'?{combinedPhrases:[{text:' '}]}:{text:' '};
    await assert.rejects(request(provider,async()=>Response.json(body))(recording()),/STT_NO_TEXT/);
    await assert.rejects(request(provider,async()=>new Response('x'.repeat(1024*1024+1)))(recording()),/STT_INVALID_RESPONSE/);
  }
});
test('timeout and caller cancellation abort HTTP work', async () => {
  const fetcher:typeof fetch=async(_input,init)=>await new Promise((_resolve,reject)=>{
    init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  });
  // Keep a live handle while AbortSignal.timeout uses an unref'ed timer.
  const keepAlive=setInterval(()=>{},1000);
  try {
    await assert.rejects(httpTranscriber('openai',{key:async()=>'synthetic-key',fetch:fetcher,timeoutMs:10})(recording()),/STT_TIMEOUT/);
    const controller=new AbortController();
    const result=httpTranscriber('openai',{key:async()=>'synthetic-key',fetch:fetcher})(recording(),controller.signal);
    await Promise.resolve(); controller.abort(); await assert.rejects(result,/STT_CANCELLED/);
  } finally {clearInterval(keepAlive);}
});
