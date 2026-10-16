import test from 'node:test';
import assert from 'node:assert/strict';
import {latestReceipt, assertReady, fingerprintPR} from '../scripts/check-review-before-merge.mjs';

const head = 'b'.repeat(40), main = 'a'.repeat(40);
const prData = {number:18,title:'A change',body:'Details',user:{login:'author'},state:'open',draft:false,base:{ref:'main'},head:{sha:head},mergeable:true,mergeable_state:'clean'};
const fingerprint = fingerprintPR(prData, main, []);
const comment = {id:10,user:{id:123,login:'dotsweeper[bot]',type:'Bot'},body:
  `<!-- dot-link-opus-review:v1 -->\n<!-- dot-link-review-owner:456:1 -->\n## dotsweeper review · Complete\n\n<!-- dot-link-review-input:head=${head};main=${main};input=${fingerprint} -->\n\nNo findings.`};
const ready = () => ({
  pr:structuredClone(prData),main,comments:[comment],
  receipt:latestReceipt([comment],123),
  run:{id:456,path:'.github/workflows/claude-review.yml',repository:{full_name:'YusukeIt0/dot-link'},status:'completed',conclusion:'success',run_attempt:1},
  jobs:['intake','review','report'].map(name=>({name,status:'completed',conclusion:'success'})),
  checks:[{name:'test',bucket:'pass'}],
});
test('published result and complete owning workflow authorize only the reviewed head',()=>{
  assert.equal(assertReady(ready()),head);
});
test('model completion alone cannot satisfy the merge gate',()=>{
  for(const change of [
    x=>x.jobs.pop(),
    x=>x.jobs[2].conclusion='failure',
    x=>x.jobs[2].status='in_progress',
    x=>x.run.status='in_progress',
    x=>x.run.conclusion='failure',
    x=>x.run.id=789,
    x=>x.run.repository.full_name='other/repo',
    x=>x.run.path='.github/workflows/other.yml',
  ]) {const x=ready();change(x);assert.throws(()=>assertReady(x));}
});
test('head/base changes, closed/draft PRs and unknown mergeability block merging',()=>{
  for(const change of [
    x=>x.pr.head.sha='c'.repeat(40),x=>x.main='c'.repeat(40),
    x=>x.pr.body='Edited',x=>x.comments.push({id:20,user:{type:'User',login:'author'},body:'New evidence'}),
    x=>x.pr.state='closed',x=>x.pr.draft=true,x=>x.pr.base.ref='other',
    x=>x.pr.mergeable=null,x=>x.pr.mergeable_state='blocked',
    x=>x.checks=[],x=>x.checks[0].bucket='pending',x=>x.checks[0].bucket='fail',
  ]) {const x=ready();change(x);assert.throws(()=>assertReady(x));}
});
test('forged and stale comments do not certify the latest review',()=>{
  assert.throws(()=>latestReceipt([{...comment,user:{...comment.user,id:999}}],123));
  assert.throws(()=>latestReceipt([{...comment,user:{...comment.user,type:'User'}}],123));
  assert.throws(()=>latestReceipt([comment,{...comment,id:11,body:comment.body.replace('Complete','Reviewing')}],123));
  assert.throws(()=>latestReceipt([{...comment,body:'<!-- dot-link-opus-review:v1 -->\n## dotsweeper review · Complete\nReviewed old head'}],123));
  assert.equal(latestReceipt([comment,{...comment,user:{...comment.user,id:999}}],123).commentId,10);
});


function childReady() {
 const x=ready();x.expectedBase='refactor/parent';x.base={ref:x.expectedBase,sha:'c'.repeat(40)};
 x.baseComparison={status:'ahead',merge_base_commit:{sha:x.base.sha}};
 x.pr.head={...x.pr.head,ref:'child',repo:{full_name:'YusukeIt0/dot-link'}};
 x.ciRun={event:'push',head_branch:'child',path:'.github/workflows/ci.yml',head_sha:head,repository:{full_name:'YusukeIt0/dot-link'},status:'completed',conclusion:'success'};
 x.ciJobs=[{name:'test',status:'completed',conclusion:'success'}];
 x.pr.base={...x.base};x.receipt={...x.receipt,base:x.base,
  fingerprint:fingerprintPR(x.pr,x.main,x.comments,x.base)};
 return x;
}
test('child integration requires an explicit target and matching parent receipt',()=>{
 assert.equal(assertReady(childReady()),head);
 for(const change of [
  x=>delete x.expectedBase,
  x=>x.expectedBase='other',
  x=>x.base={...x.base,sha:'d'.repeat(40)},
  x=>delete x.receipt.base,
  x=>x.pr.base.ref='main',
  x=>x.jobs[1].conclusion='skipped',
  x=>x.checks[0].bucket='fail',
  x=>delete x.ciRun, x=>x.ciRun.head_sha=main, x=>x.ciRun.conclusion='failure',
  x=>x.ciJobs[0].conclusion='skipped', x=>x.ciJobs=[],
 ]) {const x=childReady();change(x);assert.throws(()=>assertReady(x));}
});
test('receipt parser reads encoded child base identity; child receipt cannot authorize main',()=>{
 const row={...comment,body:comment.body.replace('\n\nNo findings.',
  `\n\n<!-- dot-link-review-base:ref=refactor%2Fparent;sha=${'c'.repeat(40)} -->\n\nNo findings.`)};
 assert.deepEqual(latestReceipt([row],123).base,{ref:'refactor/parent',sha:'c'.repeat(40)});
 const x=ready();x.receipt=latestReceipt([row],123);assert.throws(()=>assertReady(x));
});

test('unprotected parent still requires exact-head product CI when no branch-required checks exist',()=>{
 const x=childReady();x.checks=[];assert.equal(assertReady(x),head);
 x.ciRun.status='in_progress';assert.throws(()=>assertReady(x));
});

test('retargeting or parent advancement requires child ancestry as well as a fresh review',()=>{
 for(const status of ['behind','diverged']) {
  const x=childReady();x.baseComparison.status=status;assert.throws(()=>assertReady(x),/include the current parent/);
 }
 const x=childReady();x.baseComparison.merge_base_commit.sha='d'.repeat(40);
 assert.throws(()=>assertReady(x),/include the current parent/);
 const identical=childReady();identical.baseComparison.status='identical';assert.equal(assertReady(identical),head);
});

test('PR CI association must match the pinned parent; push CI tests the contained parent directly',()=>{
 const x=childReady();x.ciRun.event='pull_request';
 x.ciRun.pull_requests=[{number:x.pr.number,base:{ref:x.expectedBase,sha:x.base.sha}}];
 assert.equal(assertReady(x),head);
 x.ciRun.pull_requests[0].base.ref='old-parent';assert.throws(()=>assertReady(x));
 x.ciRun.pull_requests[0].base.ref=x.expectedBase;
 x.ciRun.pull_requests[0].base.sha='d'.repeat(40);assert.throws(()=>assertReady(x));
});
