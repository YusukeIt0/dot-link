import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWakeName, wakeNameTokens } from '../src/wake-name.ts';
import { WakeNamePreferences, WAKE_NAME_KEY } from '../src/wake-name-preferences.ts';
import { wakeTranscript } from '../src/wake-transcript.ts';
import { conversationText } from '../src/conversation-display.ts';
import { InteractionStatus } from '../src/interaction-status.ts';
import { setLanguage } from '../src/i18n.ts';

function store(raw?: string) {
  const values = new Map<string,string>(raw ? [[WAKE_NAME_KEY,raw]] : []);
  return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
}
test('ASCII names preserve case; native assistant names and non-letter input are rejected', () => {
  assert.deepEqual(validateWakeName(' Sakura '),{name:'Sakura'});
  for(const name of ['Even','eVeN',' Siri ','META','mEtA'])assert.equal(validateWakeName(name).error,'reserved');
  for(const name of ['', 'ヘイ', 'さくら', 'Ｓａｋｕｒａ','Émile','Luna2','Hey Luna','Luna!','A'.repeat(25)])assert.equal(validateWakeName(name).error,'letters');
  for(const name of ['A','Sakura','Luna','A'.repeat(24)])assert.equal(validateWakeName(name).name,name);
});
test('custom names match independent SentencePiece reference segmentations', () => {
  const vocabulary=JSON.parse(readFileSync(new URL('../distribution/wake/name-vocabulary.json',import.meta.url),'utf8'));
  const {cases}=JSON.parse(readFileSync(new URL('fixtures/wake-name-segmentation.json',import.meta.url),'utf8'));
  for(const [name,tokens] of cases)assert.deepEqual(wakeNameTokens(name,vocabulary),tokens,name);
  for(const name of ['Even','Siri','Meta'])assert.throws(()=>wakeNameTokens(name,vocabulary));
});
test('stored names cannot enable the microphone; forbidden/corrupt settings fall back to Dot', async () => {
  for(const raw of ['broken',...['Even','Siri','Meta'].map(name=>JSON.stringify({custom:true,name}))]){
    const s=store(raw),p=new WakeNamePreferences(()=>s);assert.equal(p.wakeName,'dot');assert.equal(p.assistantName,'Dot');
  }
  const s=store(),p=new WakeNamePreferences(()=>s);await p.save({custom:true,name:'Sakura'});
  assert.equal(p.assistantName,'Sakura');assert.equal(p.wakeName,'Sakura');
  assert.deepEqual([...s.values.keys()],[WAKE_NAME_KEY]);
  assert.equal(await p.save({custom:true,name:'Meta'}),false);assert.equal(p.assistantName,'Sakura');
  const restored=new WakeNamePreferences(()=>s);assert.equal(restored.assistantName,'Sakura');
  await restored.save({custom:false,name:'Sakura'});assert.equal(restored.assistantName,'Dot');assert.equal(restored.wakeName,'dot');
});
test('native restore cannot overwrite a new choice; stale origin names do not beat native defaults', async () => {
  let resolve!:(value:string)=>void;const writes:string[]=[];
  const p=new WakeNamePreferences(()=>store());
  const attaching=p.attach({getLocalStorage:()=>new Promise(r=>{resolve=r;}),setLocalStorage:async(_key,value)=>{writes.push(value);return true;}});
  await p.save({custom:true,name:'Nova'});resolve(JSON.stringify({custom:true,name:'Sakura'}));await attaching;
  assert.equal(p.assistantName,'Nova');assert.equal(JSON.parse(writes[0]).name,'Nova');
  const s=store(JSON.stringify({custom:true,name:'Luna'})),q=new WakeNamePreferences(()=>s);
  await q.attach({getLocalStorage:async()=>JSON.stringify({custom:false,name:'Luna'}),setLocalStorage:async()=>true});
  assert.equal(q.assistantName,'Dot');
  await q.attach({getLocalStorage:async()=>JSON.stringify({custom:true,name:'Siri'}),setLocalStorage:async()=>true});
  assert.equal(q.assistantName,'Dot');
});
test('failed persistence is reported and rapid name writes remain ordered', async () => {
  const writes:string[]=[];const p=new WakeNamePreferences(()=>store());
  await p.attach({getLocalStorage:async()=>'',setLocalStorage:async(_key,value)=>{writes.push(JSON.parse(value).name);return false;}});
  assert.deepEqual(await Promise.all([p.save({custom:true,name:'Sakura'}),p.save({custom:true,name:'Nova'})]),[false,false]);
  assert.deepEqual(writes,['Sakura','Nova']);
});
test('cleanup uses the captured custom cue, preserves other names and leaves default Japanese behavior intact', () => {
  assert.equal(wakeTranscript('Hey, Sakura! Where next?', 'Sakura'),'Where next?');
  assert.equal(wakeTranscript('ヘイ、Sakura。Where next?', 'Sakura'),'Where next?');
  assert.equal(wakeTranscript('Hey Sakura.', 'Sakura'),'');
  assert.equal(wakeTranscript('Sakura!', 'Sakura'),'');
  assert.equal(wakeTranscript('Hey Sakurako, hello', 'Sakura'),'Hey Sakurako, hello');
  assert.equal(wakeTranscript('Hey Dot, hello', 'Sakura'),'Hey Dot, hello');
  assert.equal(wakeTranscript('ヘイ、ドット。こんにちは'),'こんにちは');
  assert.equal(wakeTranscript('This is Sakura speaking.', 'Sakura'),'This is Sakura speaking.');
});
test('conversation and waiting status use the same chosen label in both languages and reset to Dot', () => {
  const message={id:'test',text:'Hello',reply:'Welcome',status:'replied'};
  for(const language of ['ja','en'] as const){
    setLanguage(language);
    assert.ok(conversationText(message,0,'Sakura').endsWith('\n\nSakura: Welcome'));
    assert.ok(conversationText(message,0).endsWith('\n\nDot: Welcome'));
    const status=new InteractionStatus(()=>1000);status.connection='online';status.dotConnected=true;status.begin('test','sending');status.waiting('test');
    assert.ok(status.caption('', 'test','Sakura').includes('Sakura'));
    assert.ok(!status.caption('', 'test','Sakura').includes('Dot'));
    assert.ok(status.caption('', 'test').includes('Dot'));
    assert.equal(conversationText({...message,kind:'proactive'},0,'Sakura'),'Welcome');
  }
  setLanguage('ja');
});
