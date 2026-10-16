import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEffects, type RuntimeEffectState } from '../src/runtime-effects.ts';

function fixture() {
  const state: RuntimeEffectState = {exited:false,tts:false,ready:true,paired:true,subscribed:true,online:true,
    busy:false,recording:false,draft:false,playbackBlocks:false,phaseProtect:false,waitingMs:0};
  const calls: unknown[] = [];
  let next=0;
  const timers=new Map<number,{fn:()=>void,ms:number}>();
  const hooks={speech:()=>{},voice:()=>{}};
  const effects=new RuntimeEffects({state:()=>({...state}),
    flushSpeech:()=>{calls.push('speech');hooks.speech();},
    voiceContext:(...values)=>{calls.push(['voice',...values]);hooks.voice();},
    protectStandby:value=>{calls.push(['protect',value]);},
    schedule:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id as unknown as ReturnType<typeof setTimeout>;},
    cancel:id=>{timers.delete(id as unknown as number);},
  });
  return {state,calls,timers,effects,hooks};
}

test('state effects distinguish offline availability, active recording and draft blocking',()=>{
 const f=fixture();f.effects.sync();assert.deepEqual(f.calls,[['voice',true,false,true],['protect',false]]);
 f.calls.length=0;f.state.online=false;f.state.recording=true;f.state.draft=true;f.effects.sync();
 assert.deepEqual(f.calls,[['voice',false,false,true],['protect',true]]);
 f.calls.length=0;f.state.recording=false;f.effects.sync();
 assert.deepEqual(f.calls,[['voice',false,true,true],['protect',false]]);
 f.calls.length=0;f.state.paired=false;f.effects.sync();
 assert.deepEqual(f.calls,[['voice',false,true,false],['protect',false]]);
});
test('speech-triggered synchronous updates are coalesced and input sees the new playback block',()=>{
 const f=fixture();f.state.tts=true;let once=false;
 f.hooks.speech=()=>{if(!once){once=true;f.state.playbackBlocks=true;f.effects.sync();}};
 f.effects.sync();
 assert.deepEqual(f.calls.filter(c=>Array.isArray(c)&&c[0]==='voice'),[['voice',true,true,true],['voice',true,true,true]]);
 assert.equal(f.calls.filter(c=>c==='speech').length,2);
});
test('waiting protection expires on its own timer and does not restart on unrelated updates',()=>{
 const f=fixture();f.state.waitingMs=60000;f.effects.sync();
 assert.equal([...f.timers.values()][0].ms,60000);
 f.state.waitingMs=1234;f.effects.sync();assert.equal(f.timers.size,1);
 const timer=[...f.timers.values()][0];assert.equal(timer.ms,1234);
 f.timers.clear();f.state.waitingMs=0;timer.fn();
 assert.deepEqual(f.calls.at(-1),['protect',false]);assert.equal(f.timers.size,0);
});
test('exit and stop cancel deadlines and ignore late timer callbacks',()=>{
 for(const exit of [true,false]){
  const f=fixture();f.state.waitingMs=100;f.effects.sync();const late=[...f.timers.values()][0].fn;
  if(exit){f.state.exited=true;f.effects.sync();}else f.effects.stop();
  const count=f.calls.length;late();f.effects.sync();assert.equal(f.calls.length,count);assert.equal(f.timers.size,0);
 }
});
test('voice callbacks update protection before it is applied',()=>{
 const f=fixture();f.hooks.voice=()=>{f.state.recording=true;};f.effects.sync();
 assert.deepEqual(f.calls.at(-1),['protect',true]);
});
