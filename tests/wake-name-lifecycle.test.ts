import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceInput } from '../src/voice-input.ts';
import type { WakeEvent } from '../src/wake-engine.ts';
import type { WakeDetector } from '../src/wake-detector.ts';
const tick=()=>new Promise<void>(r=>setImmediate(r));
function setup(deferred=false) {
  const calls:boolean[]=[],clips:{source:string,name:string}[]=[];
  const loads:{name:string,emit:(e:WakeEvent)=>void,fail:()=>void,resolve:()=>void,disposed:boolean}[]=[];
  const voice=new VoiceInput({microphone:async open=>{calls.push(open);return true;},
    loadWake:(emit,fail,name='dot')=>new Promise(resolve=>{
      const row={name,emit,fail,resolve:()=>resolve(detector),disposed:false};
      const detector:WakeDetector={listen:()=>{},cancel:()=>{},hold:()=>{},finish:discard=>emit({type:'clip',seconds:1,...(!discard?{wav:new Uint8Array(48)}:{})}),append:()=>{},dispose:()=>{row.disposed=true;}};
      loads.push(row);if(!deferred)resolve(detector);
    }),onClip:(_w,_s,source,name)=>clips.push({source,name}),onState:()=>{},onError:()=>{},onWakeState:()=>{}});
  voice.setContext(true,false);
  return{voice,calls,clips,loads};
}
test('name changes replace the detector and old detections or errors cannot affect the new listener',async()=>{
 const s=setup();try{
  await s.voice.setEnabled(true);await tick();await s.voice.setWakeName('Sakura');await tick();
  assert.deepEqual(s.loads.map(x=>x.name),['dot','Sakura']);assert.equal(s.loads[0].disposed,true);
  s.loads[0].emit({type:'wake'});s.loads[0].fail();assert.equal(s.voice.state,'idle');assert.equal(s.loads[1].disposed,false);
  s.loads[1].emit({type:'wake'});s.loads[1].emit({type:'clip',seconds:1,wav:new Uint8Array(48)});
  assert.deepEqual(s.clips,[{source:'wake',name:'Sakura'}]);
 }finally{await s.voice.dispose();}
});
test('changing a name with listening OFF neither loads models nor opens the microphone',async()=>{
 const s=setup();try{await s.voice.setWakeName('Luna');assert.equal(s.loads.length,0);assert.deepEqual(s.calls,[]);
 await assert.rejects(s.voice.setWakeName('META'));await s.voice.setEnabled(true);assert.equal(s.loads[0].name,'Luna');
 }finally{await s.voice.dispose();}
});
test('a captured utterance retains its old name and the pending name starts only after completion',async()=>{
 const s=setup();try{await s.voice.setEnabled(true);await tick();s.loads[0].emit({type:'wake'});
 await s.voice.setWakeName('Sakura');assert.equal(s.loads.length,1);assert.equal(s.loads[0].disposed,false);
 s.loads[0].emit({type:'clip',seconds:1,wav:new Uint8Array(48)});await tick();await tick();
 assert.deepEqual(s.clips,[{source:'wake',name:'dot'}]);assert.deepEqual(s.loads.map(x=>x.name),['dot','Sakura']);
 }finally{await s.voice.dispose();}
});
test('manual capture finishes before the pending name replaces the listener',async()=>{
 const s=setup();try{await s.voice.setEnabled(true);await tick();await s.voice.start();s.voice.append(new Uint8Array([1,0]));
 await s.voice.setWakeName('Nova');assert.equal(s.loads.length,1);await s.voice.stop();await tick();await tick();
 assert.equal(s.clips.length,1);assert.equal(s.clips[0].source,'manual');assert.deepEqual(s.loads.map(x=>x.name),['dot','Nova']);
 }finally{await s.voice.dispose();}
});
test('OFF and rapid edits invalidate pending replacement loads',async()=>{
 const s=setup(true);try{const initial=s.voice.setEnabled(true);s.loads[0].resolve();await initial;await tick();
 const first=s.voice.setWakeName('Sakura');await tick();const second=s.voice.setWakeName('Nova');await tick();
 assert.deepEqual(s.loads.map(x=>x.name),['dot','Sakura','Nova']);
 await s.voice.setEnabled(false);s.loads[2].resolve();s.loads[1].resolve();await Promise.all([first,second]);await tick();
 assert.ok(s.loads.every(x=>x.disposed));assert.deepEqual(s.calls,[true,false]);
 }finally{await s.voice.dispose();}
});
test('enabling during an initial manual capture eventually creates the requested listener',async()=>{
 const s=setup();try{await s.voice.start();s.voice.append(new Uint8Array([1,0]));await s.voice.setWakeName('Sakura');await s.voice.setEnabled(true);
 await s.voice.stop();await tick();await tick();assert.equal(s.loads.at(-1)?.name,'Sakura');
 }finally{await s.voice.dispose();}
});
