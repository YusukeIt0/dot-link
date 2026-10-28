import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { deviceServer } from '../server/device.ts';
import { selectableTranscriber } from '../server/stt.ts';
import { PcmRecording } from '../src/audio.ts';
import { readFile } from 'node:fs/promises';

test('authenticated transcription returns empty text for noise and preserves real speech', async t => {
  let calls = 0;
  const transcribe = selectableTranscriber({ selection: async () => 'whisper',
    whisper: async wav => { calls++; assert.deepEqual(wav, speech); return 'Synthetic spoken response'; },
    soniox: async () => assert.fail('Unexpected provider') });
  const server = deviceServer({origin:'https://device.example', directory:'dist', token:'a'.repeat(64), transcribe});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const address=server.address();assert(address && typeof address !== 'string');
  const call=(wav:Buffer)=>new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=request(`http://127.0.0.1:${address.port}/api/transcribe`,{method:'POST',headers:{
      Host:'device.example',Origin:'https://device.example',Authorization:`Bearer ${'a'.repeat(64)}`,'Content-Type':'audio/wav',
    }},res=>{const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));});
    req.on('error',reject);req.end(wav);
  });
  const recording=new PcmRecording();recording.append(new Uint8Array(new Int16Array(16000).fill(1000).buffer));
  assert.deepEqual(await call(Buffer.from(recording.toWav())),{status:200,body:{text:''}});assert.equal(calls,0);
  const speech=await readFile(new URL('./fixtures/speech/ko-short.wav',import.meta.url));
  assert.deepEqual(await call(speech),{status:200,body:{text:'Synthetic spoken response'}});assert.equal(calls,1);
});
