import test from 'node:test';
import { WakeEngine } from '../src/wake-engine.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { wakeManifest, sha256 } from '../scripts/lib/wake-assets.mjs';

test('real KWS timestamps remain absolute after automatic silence resets', async () => {
  const info=wakeManifest.downloads.kws, cache=resolve('.runtime/wake-assets-cache'), archive=join(cache,info.sha256);
  let data;try{data=await readFile(archive);}catch{}
  if(!data||data.length!==info.bytes||sha256(data)!==info.sha256){
    const response=await fetch(info.url,{signal:AbortSignal.timeout(120000)});assert.ok(response.ok);
    data=Buffer.from(await response.arrayBuffer());assert.equal(data.length,info.bytes);assert.equal(sha256(data),info.sha256);
    await mkdir(cache,{recursive:true});await writeFile(archive,data);
  }
  // Use the upstream model's own public test sample, from the same pinned
  // archive already downloaded for the build. No user recording is retained.
  const prefix=wakeManifest.files['tokens.txt'].entry.split('/')[0];
  const extract=name=>execFileSync('tar',['-xOf',archive,`${prefix}/${name}`],{maxBuffer:3000000});
  const wav=extract('test_wavs/1.wav');let pcm;
  for(let at=12;at+8<=wav.length;){const size=wav.readUInt32LE(at+4);if(wav.toString('ascii',at,at+4)==='data'){pcm=wav.subarray(at+8,at+8+size);break;}at+=8+size+(size%2);}
  assert.ok(pcm?.length);
  const base=new URL('../public/wake-assets/',import.meta.url);
  globalThis.require=createRequire(import.meta.url);globalThis.module={exports:{}};globalThis.__dirname=fileURLToPath(base);
  const createRuntime=(await import(new URL('runtime.js',base).href)).default;
  const {createKws}=(await import(new URL('kws.js',base).href)).default;
  const runtime=await createRuntime({locateFile:name=>new URL(name,base).href,print:()=>{},printErr:()=>{}});
  for(const name of ['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'])runtime.FS.writeFile('/'+name,await readFile(new URL(name,base)));
  runtime.FS.writeFile('/keywords.txt','▁FOR E VER @TEST\n');
  const kws=createKws(runtime,{featConfig:{samplingRate:16000,featureDim:80},modelConfig:{transducer:{encoder:'/encoder.onnx',decoder:'/decoder.onnx',joiner:'/joiner.onnx'},tokens:'/tokens.txt',numThreads:1,provider:'cpu',debug:0,modelType:'zipformer2',modelingUnit:'bpe',bpeVocab:''},maxActivePaths:4,numTrailingBlanks:1,keywordsScore:3,keywordsThreshold:0.1,keywords:'/keywords.txt'});
  function detect(delay){
    const audio=Buffer.concat([Buffer.alloc(delay*32000),pcm,Buffer.alloc(32000)]), stream=kws.createStream();
    try{
      for(let offset=0;offset<audio.length;offset+=640){
        const samples=new Float32Array(Math.min(640,audio.length-offset)/2);
        for(let i=0;i<samples.length;i++)samples[i]=audio.readInt16LE(offset+i*2)/32768;
        stream.acceptWaveform(16000,samples);
        while(kws.isReady(stream)){kws.decode(stream);const result=kws.getResult(stream);if(result.keyword)return result;}
      }
      assert.fail('Upstream fixture must produce a keyword');
    }finally{stream.free();}
  }
  try{
    const immediate=detect(0), delayed=detect(30);
    assert.equal(delayed.keyword,immediate.keyword);
    const time=r=>r.start_time+r.timestamps.at(-1);
    assert.ok(Math.abs(time(delayed)-time(immediate)-30)<0.5,`Timestamp shift: ${time(delayed)-time(immediate)}`);
    // Exercise suppression with real decoder results, then prove a later owner
    // cue can still activate on the same listening stream.
    const events=[];
    const engine=new WakeEngine({
      createStream:()=>kws.createStream(), isReady:stream=>kws.isReady(stream),
      decode:stream=>kws.decode(stream), getResult:stream=>{
        const result=kws.getResult(stream);
        return {...result,keyword:result.keyword ? 'HEY_DOT' : ''};
      }, free:()=>{},
    },{acceptWaveform(){},isDetected:()=>false,isEmpty:()=>true,reset(){},free(){}},event=>events.push(event));
    const feed=(audio,role)=>{for(let offset=0;offset<audio.length;offset+=640)engine.append(audio.subarray(offset,offset+640),role);};
    try {
      engine.listen();
      feed(pcm,'other');feed(Buffer.alloc(32000),'other');
      assert.deepEqual(events,[],'other-speaker cue must not activate with the real decoder');
      feed(pcm,'self');feed(Buffer.alloc(32000),'self');
      assert.deepEqual(events.filter(event=>event.type==='wake'),[{type:'wake'}],'owner cue after suppression must activate once');
    } finally {engine.dispose();}

  }finally{kws.free();}
});
