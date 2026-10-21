import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationPreferences } from '../src/operation-preferences.ts';
function store(value: string|null=null){const values=new Map<string,string>();if(value!==null)values.set('dot-operation-preferences-v1',value);return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,next:string)=>{values.set(key,next);}};}
test('missing and corrupt preferences default to OFF; explicit OFF survives native restore',async()=>{
  for(const value of [null,'broken','false'])assert.equal(new OperationPreferences(()=>store(value)).wakeWord,false);
  const prefs=new OperationPreferences(()=>store('false'));
  await prefs.attach({getLocalStorage:async()=> 'true',setLocalStorage:async()=>true});assert.equal(prefs.wakeWord,false);
});
test('an in-flight native restore cannot undo the latest user choice',async()=>{
  let resolve!:(value:string)=>void;const prefs=new OperationPreferences(()=>store());
  const restore=prefs.attach({getLocalStorage:key=>key==='dot-operation-preferences-v1'?new Promise(r=>{resolve=r;}):Promise.resolve(''),setLocalStorage:async()=>true});
  await prefs.save(false);resolve('true');await restore;assert.equal(prefs.wakeWord,false);
});
test('native writes stay in order and both stores failing is reported',async()=>{
  const writes:string[]=[];const prefs=new OperationPreferences(()=>{throw new Error('blocked');});
  await prefs.attach({getLocalStorage:async()=>'',setLocalStorage:async(_key,value)=>{writes.push(value);return true;}});
  assert.deepEqual(await Promise.all([prefs.save(true),prefs.save(false)]),[true,true]);assert.deepEqual(writes,['true','false']);
  const broken=new OperationPreferences(()=>{throw new Error('blocked');});assert.equal(await broken.save(true),false);
});

test('native OFF overrides an old WebView ON value; a fresh user choice still wins',async()=>{
  const prefs=new OperationPreferences(()=>store('true'));
  await prefs.attach({getLocalStorage:async()=> 'false',setLocalStorage:async()=>true});assert.equal(prefs.wakeWord,false);
  const writes:string[]=[];const fresh=new OperationPreferences(()=>store('false'));await fresh.save(true);
  await fresh.attach({getLocalStorage:async()=> 'false',setLocalStorage:async(_key,value)=>{writes.push(value);return true;}});
  assert.equal(fresh.wakeWord,true);assert.deepEqual(writes,['true']);
});

test('failed native persistence is reported even if a current-origin copy was saved',async()=>{
  const prefs=new OperationPreferences(()=>store('true'));
  await prefs.attach({getLocalStorage:async()=> 'true',setLocalStorage:async()=>false});
  assert.equal(await prefs.save(false),false);assert.equal(prefs.wakeWord,false);
});

const holdKey = 'dot-disable-hold-recording-v1';
test('hold disable defaults off, persists independently, and survives reopening', async () => {
  const local = store('false');
  const native = new Map<string,string>();
  const prefs = new OperationPreferences(() => local);
  assert.equal(prefs.disableHoldRecording, false);
  await prefs.attach({getLocalStorage:async key=>native.get(key)??'',setLocalStorage:async(key,value)=>{native.set(key,value);return true;}});
  assert.equal(await prefs.saveDisableHoldRecording(true), true);
  assert.equal(prefs.wakeWord, false);
  await prefs.save(true);
  assert.equal(prefs.disableHoldRecording, true);
  assert.equal(native.get(holdKey), 'true');
  const reopened = new OperationPreferences(() => local);
  assert.equal(reopened.disableHoldRecording, true);
  const newOrigin = new OperationPreferences(() => store());
  await newOrigin.attach({getLocalStorage:async key=>native.get(key)??'',setLocalStorage:async()=>true});
  assert.equal(newOrigin.disableHoldRecording, true);
});
test('conflicting hold copies preserve disabled input and a fresh choice outranks restore', async () => {
  for (const [localValue,nativeValue] of [['true','false'],['false','true']]) {
    const local=store();local.setItem(holdKey,localValue);
    const prefs=new OperationPreferences(()=>local);
    await prefs.attach({getLocalStorage:async key=>key===holdKey?nativeValue:'',setLocalStorage:async()=>true});
    assert.equal(prefs.disableHoldRecording,true);
  }
  let restore!:(value:string)=>void;
  const local=store();local.setItem(holdKey,'true');
  const prefs=new OperationPreferences(()=>local);
  const pending=prefs.attach({getLocalStorage:key=>key===holdKey?new Promise(r=>{restore=r;}):Promise.resolve(''),setLocalStorage:async()=>true});
  await prefs.saveDisableHoldRecording(false);restore('true');await pending;
  assert.equal(prefs.disableHoldRecording,false);
});
test('hold writes stay ordered and failed native persistence does not undo protection', async () => {
  const writes:string[]=[];const prefs=new OperationPreferences(()=>store());
  await prefs.attach({getLocalStorage:async()=>'',setLocalStorage:async(key,value)=>{if(key===holdKey)writes.push(value);return false;}});
  assert.deepEqual(await Promise.all([prefs.saveDisableHoldRecording(false),prefs.saveDisableHoldRecording(true)]),[false,false]);
  assert.deepEqual(writes,['false','true']);assert.equal(prefs.disableHoldRecording,true);
});

test('failed native restore on a fresh origin protects input without persisting a guess', async () => {
  const local=store();const prefs=new OperationPreferences(()=>local);
  await prefs.attach({getLocalStorage:async()=>{throw new Error('unavailable');},setLocalStorage:async()=>true});
  assert.equal(prefs.disableHoldRecording,true);assert.equal(prefs.wakeWord,false);
  assert.equal(local.getItem(holdKey),null);
  // The user can explicitly opt back into manual recording for this session.
  await prefs.saveDisableHoldRecording(false);assert.equal(prefs.disableHoldRecording,false);
  assert.equal(local.getItem(holdKey),'false');
});
test('native restore timeout protects input, ignores a late result, and lets the next launch retry', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const local=store();const prefs=new OperationPreferences(()=>local);let resolve!:(value:string)=>void;
  const restore=prefs.attach({getLocalStorage:key=>key===holdKey?new Promise(r=>{resolve=r;}):Promise.resolve(''),setLocalStorage:async()=>true});
  t.mock.timers.tick(3000);await restore;
  assert.equal(prefs.disableHoldRecording,true);assert.equal(local.getItem(holdKey),null);
  resolve('false');await Promise.resolve();assert.equal(prefs.disableHoldRecording,true);
  const next=new OperationPreferences(()=>local);
  await next.attach({getLocalStorage:async()=>'',setLocalStorage:async()=>true});
  assert.equal(next.disableHoldRecording,false,'a confirmed unset preference retains the original default');
});
test('failed restore cannot override either a local copy or a fresh choice', async () => {
  const local=store();local.setItem(holdKey,'false');const known=new OperationPreferences(()=>local);
  await known.attach({getLocalStorage:async()=>{throw new Error('unavailable');},setLocalStorage:async()=>true});
  assert.equal(known.disableHoldRecording,false);
  let reject!:(error:Error)=>void;
  const fresh=new OperationPreferences(()=>{throw new Error('local storage unavailable');});
  const pending=fresh.attach({getLocalStorage:key=>key===holdKey?new Promise((_r,j)=>{reject=j;}):Promise.resolve(''),setLocalStorage:async()=>false});
  await fresh.saveDisableHoldRecording(false);reject(new Error('native unavailable'));await pending;
  assert.equal(fresh.disableHoldRecording,false);
});
