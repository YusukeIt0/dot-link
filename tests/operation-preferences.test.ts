import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationPreferences } from '../src/operation-preferences.ts';
function store(value: string|null=null){return {getItem:()=>value,setItem:(_key:string,next:string)=>{value=next;}};}
test('missing and corrupt preferences default to OFF; explicit OFF survives native restore',async()=>{
  for(const value of [null,'broken','false'])assert.equal(new OperationPreferences(()=>store(value)).wakeWord,false);
  const prefs=new OperationPreferences(()=>store('false'));
  await prefs.attach({getLocalStorage:async()=> 'true',setLocalStorage:async()=>true});assert.equal(prefs.wakeWord,false);
});
test('an in-flight native restore cannot undo the latest user choice',async()=>{
  let resolve!:(value:string)=>void;const prefs=new OperationPreferences(()=>store());
  const restore=prefs.attach({getLocalStorage:()=>new Promise(r=>{resolve=r;}),setLocalStorage:async()=>true});
  await prefs.save(false);resolve('true');await restore;assert.equal(prefs.wakeWord,false);
});
test('native writes stay in order and both stores failing is reported',async()=>{
  const writes:string[]=[];const prefs=new OperationPreferences(()=>{throw new Error('blocked');});
  await prefs.attach({getLocalStorage:async()=>'',setLocalStorage:async(_key,value)=>{writes.push(value);return true;}});
  assert.deepEqual(await Promise.all([prefs.save(true),prefs.save(false)]),[true,true]);assert.deepEqual(writes,['true','false']);
  const broken=new OperationPreferences(()=>{throw new Error('blocked');});assert.equal(await broken.save(true),false);
});
