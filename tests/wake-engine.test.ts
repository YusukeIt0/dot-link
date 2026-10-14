import test from 'node:test';
import assert from 'node:assert/strict';
import { WakeEngine, type WakeEvent } from '../src/wake-engine.ts';
import { wakeTranscript } from '../src/wake-transcript.ts';
function fixture(detectAt=50,lastTimestamp=0.5) {
  let ready=false, frames=0, frees=0, end=false, speech=false;
  const events: WakeEvent[]=[];
  const engine=new WakeEngine({createStream:()=>({acceptWaveform:()=>{frames++;ready=frames===detectAt;},free:()=>{frees++;}}),
    isReady:()=>ready,decode:()=>{ready=false;},getResult:()=>({keyword:'HEY_DOT',start_time:0,timestamps:[0.1,0.2,0.4,lastTimestamp]}),free:()=>{}},
    {acceptWaveform:()=>{},isDetected:()=>speech,isEmpty:()=>!end,reset:()=>{end=false;speech=false;},free:()=>{}}, e=>events.push(e));
  const feed=(seconds:number,value=123)=>{const b=new Uint8Array(640);const v=new DataView(b.buffer);for(let i=0;i<320;i++)v.setInt16(i*2,value,true);for(let i=0;i<seconds*50;i++)engine.append(b);};
  engine.listen();
  return {engine,events,feed,speech:()=>{speech=true;},end:()=>{end=true;},frees:()=>frees};
}

test('wake cue trims earlier audio, preserves decoder-latency speech, and ends on silence',()=>{
  const f=fixture();f.feed(1);assert.deepEqual(f.events,[{type:'wake'}]);assert.equal(f.frees(),1);
  f.speech();f.feed(.5,456);f.end();f.feed(.04,0);
  assert.equal(f.events.length,2);const event=f.events[1];assert.equal(event.type,'clip');
  if(event.type!=='clip')return;
  assert.ok(event.wav);assert.ok(event.seconds>=.8&&event.seconds<=.84);
  assert.equal(new DataView(event.wav.buffer).getInt16(44,true),123);
  f.feed(2);assert.equal(f.events.length,2);f.engine.dispose();
});

test('wake with no following speech expires without a clip',()=>{
  const f=fixture();f.feed(8);assert.equal(f.events.length,2);
  assert.equal(f.events[1].type,'clip');assert.equal('wav' in f.events[1],false);f.engine.dispose();
});

test('held speech ignores the automatic endpoint, discard and max length stay bounded',()=>{
  const f=fixture();f.feed(1);f.engine.hold();f.speech();f.end();f.feed(3);
  assert.equal(f.events.length,1);f.engine.finish(true);assert.equal('wav' in f.events[1],false);f.engine.dispose();
  const g=fixture();g.feed(1);g.engine.hold();g.feed(35);const e=g.events[1];
  assert.equal(e.type,'clip');if(e.type==='clip'){assert.equal(e.seconds,30);assert.equal(e.wav?.length,960044);}g.engine.dispose();
});

test('cancel erases an utterance and rejects malformed frames',()=>{
  const f=fixture();f.feed(1);f.engine.cancel();f.feed(2);assert.equal(f.events.length,1);
  assert.throws(()=>f.engine.append(new Uint8Array(3)));assert.throws(()=>f.engine.append(new Uint8Array(32002)));f.engine.dispose();
});

test('wake text is an activation cue, without changing ordinary content',()=>{
  for(const text of ['Hey dot!','HEY, DOT.','ヘイ、ドット','dot.','ドット。'])assert.equal(wakeTranscript(text),'');
  assert.equal(wakeTranscript('Hey dot, what time is it?'),'what time is it?');
  assert.equal(wakeTranscript('ヘイ、ドット。今日の天気は？'),'今日の天気は？');
  assert.equal(wakeTranscript('Tell me about the dot product.'),'Tell me about the dot product.');
});


test('out-of-window keyword timestamps never copy pre-wake audio into the utterance',()=>{
  for(const [frames,last] of [[200,0.5],[50,4]]){
    const f=fixture(frames,last);f.feed(frames/50,123);f.speech();f.feed(.5,456);f.end();f.feed(.04,0);
    const event=f.events[1];assert.equal(event.type,'clip');
    if(event.type==='clip'){assert.ok(event.wav);assert.ok(event.seconds<.56);assert.equal(new DataView(event.wav.buffer).getInt16(44,true),456);}
    f.engine.dispose();
  }
});
