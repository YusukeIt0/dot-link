import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTriage, planLabels} from '../scripts/review-labels.mjs';
const bot={id:98765,login:'dotsweeper[bot]',type:'Bot'};
const human={id:123,login:'owner',type:'User'};
const triage={priority:'P1',priority_reason:'Core delivery fails',labels:[{name:'bug',reason:'Reported failure'},{name:'reliability',reason:'Delivery impact'}]};
const event=(name,actor=bot,action='labeled')=>({event:action,label:{name},actor});
test('only catalog values with nonempty rationales are accepted',()=>{
 assert.deepEqual(validateTriage(triage,x=>x),triage);
 for(const value of [{...triage,priority:'P9'},{...triage,priority_reason:''},{...triage,labels:[{name:'triage:manual',reason:'x'}]},{...triage,labels:[{name:'bug',reason:''}]},{...triage,labels:[...triage.labels,triage.labels[0]]}]) assert.throws(()=>validateTriage(value,x=>x));
});
test('new issue gets at most one priority and catalog categories',()=>{
 assert.deepEqual(planLabels([],[],triage,98765).add,['bug','reliability','P1']);
 assert.deepEqual(planLabels([],[],{...triage,priority:null},98765).add,['bug','reliability']);
});
test('existing priorities and manual lock are never overwritten',()=>{
 const plan=planLabels(['P2','custom'],[],triage,98765);
 assert.deepEqual(plan.add,['bug','reliability']);assert.deepEqual(plan.remove,[]);
 const locked=planLabels(['triage:manual'],[],triage,98765);
 assert.deepEqual(locked.add,[]);assert.deepEqual(locked.remove,[]);
});
test('only categories currently owned by the exact bot are removed',()=>{
 const current=['needs-info','ux','enhancement','custom'];
 const events=[event('needs-info'),event('ux',human),event('enhancement',{...bot,id:1}),event('custom')];
 assert.deepEqual(planLabels(current,events,triage,98765).remove,['needs-info']);
});
test('human removal or re-addition wins; bot removals can be reconsidered',()=>{
 const events=[event('bug'),event('bug',human,'unlabeled'),event('reliability',bot,'unlabeled')];
 assert.deepEqual(planLabels([],events,triage,98765).add,['reliability','P1']);
 assert.deepEqual(planLabels(['needs-info'],[event('needs-info'),event('needs-info',human)],triage,98765).remove,[]);
});
