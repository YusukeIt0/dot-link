import test from 'node:test';
import {latestReceipt, fingerprintPR} from '../scripts/check-review-before-merge.mjs';
import {policy, acceptanceMarker, scopeDigest} from '../scripts/review-evidence.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const script = resolve('scripts/claude-review.mjs');
const main = 'a'.repeat(40), head = 'b'.repeat(40);
// Exercise the env contract of the actual workflow, not a richer test-only env.
const workflow = readFileSync(resolve('.github/workflows/claude-review.yml'), 'utf8');
const prepareStep = workflow.split('      - name: Prepare read-only review input\n')[1].split('      - name: Check subscription credential\n')[0];
const prepareEnvKeys = new Set([...prepareStep.matchAll(/^          ([A-Z_]+):/gm)].map(m=>m[1]));
const user = {id: 123, login: 'contributor', type: 'User'};
const issue = {number: 12, title: 'History disappears', body: 'After reopening the app', state: 'open', locked: false, user};
const pr = {number: 12, state: 'open', draft: false, changed_files: 1,
  base: {ref: 'main', sha: main, repo: {full_name:'YusukeIt0/dot-link'}}, head: {sha: head, repo: {full_name: 'external/fork'}}};
const result = {summary: 'Review complete', findings: [{severity: 'medium', file: 'src/main.ts', line: 7,
  title: 'State lost', reason: 'Saved state is overwritten'}], next_steps: 'Verify persistence', limitations: 'Static review only', triage: {priority: 'P1', priority_reason: 'Core state loss', labels: [{name: 'bug', reason: 'State disappears'}]}};
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dot-review-test-'));
  const data = {issue, pr, main, comments: [], permission: 'read', diff: '+new line\n', ...options};
  data.comments = data.comments.map(r => ({node_id: 'comment' + r.id, updated_at: '2026-10-17', revision_verified: true, revision_author: r.user, ...r}));
  const event = options.event || {action: 'opened', issue: data.issue, sender: user};
  writeFileSync(join(dir, 'event.json'), JSON.stringify(event));
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2), p = a[1];
const f = JSON.parse(fs.readFileSync('fixture.json'));
if(p === 'graphql') {
 const id = a.find(x => x.startsWith('id=')).slice(3);
 const row = f.comments.find(x => x.node_id === id);
 const actor = user => ({__typename:user.type,login:user.login,databaseId:user.id});
 console.log(JSON.stringify({data:{node:row ? {id,body:row.body,updatedAt:row.updated_at,lastEditedAt:row.editor ? row.updated_at : null,author:actor(row.user),editor:row.editor ? actor(row.editor) : null} : null}})); process.exit(0);
}
if (!a.includes('--input') && f.failRead && p.includes(f.failRead)) { console.error('simulated API failure'); process.exit(1); }
if(a.includes('--input')) {
 const body = JSON.parse(fs.readFileSync(0, 'utf8'));
 if(body.body && (body.body.length > 65536 || Buffer.byteLength(body.body)>65536)) { console.error('comment too large'); process.exit(1); }
 fs.appendFileSync('writes.jsonl', JSON.stringify({path:p,body})+'\\n');
 if(p.includes('/labels')) { if(f.failLabels) process.exit(1); console.log('{}'); process.exit(0); }
 const row = {id:999,node_id:'comment999',updated_at:'2026-10-17',revision_verified:true,revision_author:{id:98765,login:'dotsweeper[bot]',type:'Bot'},user:{id:98765,login:'dotsweeper[bot]',type:'Bot'},body:body.body,html_url:'https://github.com/YusukeIt0/dot-link/issues/12#issuecomment-999'};
 if(p.endsWith('/comments/999')) f.comments=f.comments.filter(x=>x.id!==999);
 f.comments.push(row); fs.writeFileSync('fixture.json',JSON.stringify(f));
 console.log(JSON.stringify(row));
} else if(a.includes('Accept: application/vnd.github.diff')) { if(f.failDiff) process.exit(1); process.stdout.write(f.diff); }
else if(p.endsWith('/commits/main')) { f.mainReads=(f.mainReads||0)+1; if(f.changeAfterMainReads && f.mainReads>f.changeAfterMainReads) f.main='c'.repeat(40); fs.writeFileSync('fixture.json',JSON.stringify(f)); console.log(JSON.stringify({sha:f.main})); }
else if(p.includes('/commits/')) { console.log(JSON.stringify({sha:f.baseSha || f.pr.base.sha})); }
else if(p.includes('/events?')) console.log(JSON.stringify([f.events || []]));
else if(p.includes('/pulls/') && p.includes('/comments?')) console.log(JSON.stringify([f.inlineComments || []]));
else if(p.includes('/reviews?')) console.log(JSON.stringify([f.reviews || []]));
else if(p.includes('/issues/73/comments?')) console.log(JSON.stringify([f.scopeComments || []]));
else if(p.includes('/comments?')) console.log(JSON.stringify([f.comments]));
else if(p.endsWith('/issues/73')) console.log(JSON.stringify(f.scopeIssue));
else if(p.includes('/issues?')) console.log(JSON.stringify(f.related || []));
else if(p.includes('/actions/workflows/ci.yml/runs')) console.log(JSON.stringify({workflow_runs:f.ciRuns || []}));
else if(p.includes('/issues/comments/')) console.log(JSON.stringify(f.command));
else if(p.includes('/collaborators/')) console.log(JSON.stringify({permission:f.permission}));
else if(p.includes('/files?')) console.log(JSON.stringify([{filename:'src/main.ts'}]));
else if(p.includes('/pulls/')) console.log(JSON.stringify(f.pr));
else {
 f.issueReads=(f.issueReads||0)+1;
 const update=f.atIssueRead?.[f.issueReads];
 if(update) { if(update.issue) f.issue={...f.issue,...update.issue}; if(update.pr) f.pr={...f.pr,...update.pr}; if(update.newOwner) f.comments=f.comments.map(x=>({...x,body:x.body.replace(/dot-link-review-owner:[0-9:]+/, 'dot-link-review-owner:'+update.newOwner)})); }
 fs.writeFileSync('fixture.json',JSON.stringify(f)); console.log(JSON.stringify(f.issue));
}
`, {mode: 0o700});
  writeFileSync(join(dir, 'git'), `#!/usr/bin/env node
const fs = require('node:fs'), args=process.argv.slice(2);
const f=JSON.parse(fs.readFileSync('fixture.json'));
fs.appendFileSync('git.jsonl',JSON.stringify(args)+'\\n');
if(args.includes('fetch')) { if(f.failFetch) process.exit(1); }
else if(args[0]==='diff') process.stdout.write(f.baseDiff || '');
else process.exit(2);
`, {mode:0o700});
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(data));
  let outputs = {};
  const run = (mode, env = {}) => {
    writeFileSync(join(dir, 'output'), '');
    const runEnv = {
      ...process.env, PATH: dir + ':' + process.env.PATH,
      GITHUB_REPOSITORY: 'YusukeIt0/dot-link', GITHUB_EVENT_PATH: join(dir, 'event.json'),
      GITHUB_EVENT_NAME: options.eventName || 'issues', GITHUB_RUN_ID: '1234', ITEM_NUMBER: '12',
      GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      GITHUB_RUN_ATTEMPT: '1', REVIEW_OWNER: outputs.owner,
      REVIEW_FINGERPRINT: outputs.fingerprint, REVIEW_MAIN_SHA: outputs.main_sha,
      REVIEW_BOT_ID: '98765', REVIEW_WRITE_TOKEN: 'fixture-token', REVIEW_OUTCOME: 'success', REVIEW_JSON: JSON.stringify(result),
    };
    if (mode === 'prepare') for (const key of Object.keys(runEnv)) {
      if (key.startsWith('REVIEW_') && !prepareEnvKeys.has(key)) delete runEnv[key];
    }
    Object.assign(runEnv, env);
    const r = spawnSync(process.execPath, [script, mode], {cwd: dir, encoding:'utf8', env:runEnv});
    const out = Object.fromEntries(readFileSync(join(dir, 'output'), 'utf8').trim().split('\n').filter(Boolean).map(x => x.split('=')));
    outputs = {...outputs, ...out};
    return {...r, outputs: out};
  };
  return {dir, run, read: () => JSON.parse(readFileSync(join(dir, 'fixture.json'))),
    update: update => { const f = JSON.parse(readFileSync(join(dir, 'fixture.json'))); writeFileSync(join(dir, 'fixture.json'), JSON.stringify({...f, ...update})); },
    writes: () => existsSync(join(dir, 'writes.jsonl')) ? readFileSync(join(dir, 'writes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [],
    cleanup: () => rmSync(dir, {recursive:true,force:true})};
}
function use(t, options) { const f = fixture(options); t.after(f.cleanup); return f; }
function success(r) { assert.equal(r.status, 0, r.stderr); }

test('issue lifecycle acknowledges, prepares and updates one bot comment', t => {
  const f=use(t); success(f.run('intake')); success(f.run('prepare')); success(f.run('report'));
  assert.equal(f.read().comments.length, 1);
  assert.match(f.read().comments[0].body, /Complete/);
  assert.equal(f.writes().at(-1).path, 'repos/YusukeIt0/dot-link/issues/comments/999');
  assert.deepEqual(f.writes().find(x=>x.path.endsWith('/labels')).body.labels,['bug','P1']);
});
test('external fork PR is accepted; no contributor checkout or execution occurs', t => {
  const f=use(t, {issue:{...issue,pull_request:{}}, eventName:'pull_request_target', event:{action:'opened',pull_request:pr,sender:user}});
  success(f.run('intake')); success(f.run('prepare')); success(f.run('report'));
  assert.match(f.read().comments[0].body, /src\/main.ts:7/);
  assert.match(readFileSync(join(f.dir,'.review/changes.diff'),'utf8'), /new line/);
  const live=f.read();const receipt=latestReceipt(live.comments,98765);
  assert.equal(receipt.fingerprint,fingerprintPR({...live.issue,...live.pr},live.main,live.comments));
});
test('draft, closed, locked or foreign-base items do not start a review', t => {
  for(const opts of [{issue:{...issue,state:'closed'}},{issue:{...issue,locked:true}},
    {issue:{...issue,pull_request:{}},pr:{...pr,draft:true}},
    {issue:{...issue,pull_request:{}},pr:{...pr,base:{...pr.base,repo:{full_name:'other/repo'}}}}]) {
    const f=use(t,opts); const r=f.run('intake'); success(r); assert.equal(r.outputs.accepted,'false'); assert.equal(f.writes().length,0);
  }
});
test('only author or write-access maintainer can request another review', t => {
  const other={id:456,login:'other',type:'User'};
  for(const [actor, permission, accepted] of [[user,'read',true],[other,'read',false],[other,'write',true]]) {
    const command={id:77,user:actor,body:'/dotlink review',issue_url:'https://api.github.com/repos/YusukeIt0/dot-link/issues/12'};
    const f=use(t,{eventName:'issue_comment',event:{action:'created',issue,sender:actor,comment:command},command,permission});
    const r=f.run('intake'); success(r); assert.equal(r.outputs.accepted,String(accepted));
  }
});
test('edited command, wrong destination and bot sender cannot trigger a review', t => {
  const command={id:77,user,body:'/dotlink review',issue_url:'https://api.github.com/repos/YusukeIt0/dot-link/issues/12'};
  for(const update of [{command:{...command,body:'/opus review'}},{command:{...command,body:'cancel'}},{command:{...command,body:'/dotlink review '}},{command:{...command,issue_url:'https://api.github.com/repos/other/repo/issues/12'}},
    {event:{action:'created',issue,sender:{...user,type:'Bot'},comment:command}}]) {
    const f=use(t,{eventName:'issue_comment',event:{action:'created',issue,sender:user,comment:command},command,...update});
    success(f.run('intake')); assert.equal(f.writes().length,0);
  }
});
test('edited issue, added human comment, new main and changed PR head invalidate results', t => {
  for(const update of [{issue:{...issue,pull_request:{},body:'Changed'}},{main:'c'.repeat(40)},
    {pr:{...pr,head:{...pr.head,sha:'c'.repeat(40)}}}]) {
    const f=use(t,{issue:{...issue,pull_request:{}}}); success(f.run('intake')); f.update(update); success(f.run('report'));
    assert.match(f.read().comments[0].body,/Outdated/); assert.doesNotMatch(f.read().comments[0].body,/State lost/);
  }
  const f=use(t); success(f.run('intake')); f.update({comments:[...f.read().comments,{id:78,user,body:'New evidence'}]}); success(f.run('report'));
  assert.match(f.read().comments.find(x=>x.id===999).body,/Outdated/);
});
test('failure or invalid output is visible and never called a clean review', t => {
  for(const env of [{REVIEW_OUTCOME:'failure'},{REVIEW_JSON:'not json'},
    {REVIEW_JSON:JSON.stringify({...result,summary:'sk-ant-sensitive-output'})}]) {
    const f=use(t); success(f.run('intake')); assert.notEqual(f.run('report',env).status,0);
    assert.match(f.read().comments[0].body,/Failed/); assert.doesNotMatch(f.read().comments[0].body,/Complete|sk-ant-/);
  }
});
test('oversized input is acknowledged without model execution', t => {
  const f=use(t,{issue:{...issue,body:'x'.repeat(150001)}}); const r=f.run('intake'); success(r);
  assert.equal(r.outputs.accepted,'false'); assert.match(f.read().comments[0].body,/smaller scope/);
});
test('forged marker is not edited; newer run prevents stale overwrite', t => {
  const fake={id:88,user,body:'<!-- dot-link-opus-review:v1 --> forged'};
  const f=use(t,{comments:[fake]}); success(f.run('intake'));
  assert.equal(f.read().comments[0].body,fake.body);
  const r=f.run('report',{GITHUB_RUN_ID:'5678',REVIEW_OWNER:'5678:1'}); success(r); assert.match(readFileSync(join(f.dir,'summary'),'utf8'),/Superseded/); assert.equal(f.writes().length,1);
});
test('invalid identifiers and changed preparation snapshot are rejected', t => {
  const f=use(t); assert.notEqual(f.run('intake',{ITEM_NUMBER:'12;echo bad'}).status,0);
  success(f.run('intake')); const prepared=f.run('prepare',{REVIEW_FINGERPRINT:'stale'}); success(prepared); assert.equal(prepared.outputs.ready,'false'); assert.equal(existsSync(join(f.dir,'.review/input.json')),false);
});

test('publishing requires app identity; legacy or spoofed bot comments remain untouched', t => {
  const marker='<!-- dot-link-opus-review:v1 -->';
  const rows=[
    {id:80,user:{id:41898282,login:'github-actions[bot]',type:'Bot'},body:marker+' old'},
    {id:81,user:{id:22,login:'dotsweeper[bot]',type:'Bot'},body:marker+' wrong id'},
    {id:82,user:{id:98765,login:'someone-else[bot]',type:'Bot'},body:marker+' wrong login'},
  ];
  const f=use(t,{comments:rows});
  const originalComments = f.read().comments;
  assert.notEqual(f.run('intake',{REVIEW_BOT_ID:''}).status,0);
  assert.notEqual(f.run('intake',{REVIEW_WRITE_TOKEN:''}).status,0);
  assert.equal(f.writes().length,0);
  success(f.run('intake')); success(f.run('prepare')); success(f.run('report'));
  assert.deepEqual(f.read().comments.slice(0,3),originalComments);
  assert.equal(f.read().comments.length,4);
  assert.equal(f.read().comments[3].user.login,'dotsweeper[bot]');
});


test('PRs and outdated/invalid/failed reviews never mutate labels', t => {
 for (const opts of [{issue:{...issue,pull_request:{}}},{stale:true},{invalid:true},{failed:true}]) {
  const f=use(t,opts); success(f.run('intake'));
  if(opts.stale) f.update({main:'c'.repeat(40)});
  const report=f.run('report',opts.invalid?{REVIEW_JSON:JSON.stringify({...result,triage:{...result.triage,labels:[{name:'arbitrary',reason:'x'}]}})}:opts.failed?{REVIEW_OUTCOME:'failure'}:{});
  if(opts.invalid||opts.failed) assert.notEqual(report.status,0); else success(report);
  assert.equal(f.writes().filter(x=>x.path.includes('/labels')).length,0);
 }
});
test('priority added during model review is preserved; manual lock skips all writes', t => {
 for(const labels of [[{name:'P2'}],[{name:'triage:manual'}]]) {
  const f=use(t); success(f.run('intake'));f.update({issue:{...issue,labels}});success(f.run('report'));
  const writes=f.writes().filter(x=>x.path.includes('/labels'));
  if(labels[0].name==='P2') assert.deepEqual(writes[0].body.labels,['bug']);
  else assert.equal(writes.length,0);
 }
});
test('label mutation failure is explicit while preserving review findings', t => {
 const f=use(t,{failLabels:true});success(f.run('intake'));
 assert.notEqual(f.run('report').status,0);
 assert.match(f.read().comments[0].body,/Label synchronization failed or was partial/);
 assert.match(f.read().comments[0].body,/State lost/);
});


test('late main change publishes Outdated without any label mutation', t => {
 const f=use(t,{changeAfterMainReads:2});success(f.run('intake'));success(f.run('report'));
 assert.match(f.read().comments[0].body,/Outdated/);
 assert.doesNotMatch(f.read().comments[0].body,/Reviewing|State lost/);
 assert.equal(f.writes().filter(x=>x.path.includes('/labels')).length,0);
});
test('PR findings do not depend on unused issue triage fields', t => {
 for(const triage of [undefined,{priority:null,priority_reason:'',labels:[]}]) {
  const f=use(t,{issue:{...issue,pull_request:{}}});success(f.run('intake'));
  success(f.run('report',{REVIEW_JSON:JSON.stringify({...result,triage})}));
  assert.match(f.read().comments[0].body,/Complete/);
  assert.equal(f.writes().filter(x=>x.path.includes('/labels')).length,0);
 }
});


const transitions = [
  {name:'merged PR', start:{issue:{...issue,pull_request:{}}}, change:{issue:{state:'closed'},pr:{state:'closed',merged:true}}, state:'Skipped'},
  {name:'closed issue', start:{}, change:{issue:{state:'closed'}}, state:'Skipped'},
  {name:'locked issue', start:{}, change:{issue:{locked:true}}, state:'Skipped', noWrite:true},
  {name:'draft PR', start:{issue:{...issue,pull_request:{}}}, change:{pr:{draft:true}}, state:'Skipped'},
  {name:'retargeted PR', start:{issue:{...issue,pull_request:{}}}, change:{pr:{base:{...pr.base,ref:'other'}}}, state:'Outdated'},
  {name:'changed PR head', start:{issue:{...issue,pull_request:{}}}, change:{pr:{head:{sha:'c'.repeat(40)}}}, state:'Outdated'},
  {name:'newer run', start:{}, change:{newOwner:'5678:1'}, state:'Superseded', noWrite:true},
];
for (const transition of transitions) {
 test(`${transition.name} restored after a successful preparation stop stays skipped`, t => {
  const originalIssue = transition.start.issue || issue;
  const f=use(t,{...transition.start,atIssueRead:{2:transition.change}});success(f.run('intake'));
  const originalComments=f.read().comments;
  const prepared=f.run('prepare');success(prepared);assert.equal(prepared.outputs.ready,'false');
  f.update({issue:originalIssue,pr,comments:originalComments,atIssueRead:{}});
  success(f.run('report',{REVIEW_PREPARED:'false'}));
  assert.match(f.read().comments[0].body,/Skipped/);
  assert.doesNotMatch(f.read().comments[0].body,/Complete|Failed/);
  assert.equal(f.writes().filter(x=>x.path.includes('/labels')).length,0);
 });
 test(`${transition.name} before preparation skips model input`, t => {
  const f=use(t,{...transition.start,atIssueRead:{2:transition.change}});success(f.run('intake'));
  const r=f.run('prepare');success(r);assert.equal(r.outputs.ready,'false');
  assert.equal(existsSync(join(f.dir,'.review/input.json')),false);
  success(f.run('report',{REVIEW_PREPARED:'false'}));
  assert.match(readFileSync(join(f.dir,'summary'),'utf8'),new RegExp(transition.state));
  assert.equal(f.writes().filter(x=>x.path.includes('/labels')).length,0);
 });
 for (const issueRead of [2,3]) test(`${transition.name} at report read ${issueRead} withholds findings and labels`,t=>{
  const f=use(t,{...transition.start,atIssueRead:{[issueRead]:transition.change}});success(f.run('intake'));
  success(f.run('report'));
  assert.match(readFileSync(join(f.dir,'summary'),'utf8'),new RegExp(transition.state));
  const writes=f.writes().slice(1);
  assert.equal(writes.filter(x=>x.path.includes('/labels')).length,0);
  assert.ok(writes.every(x=>!x.body.body?.includes('State lost')));
  if(transition.noWrite) assert.equal(writes.length,0);
  else assert.doesNotMatch(f.read().comments[0].body,/Reviewing/);
 });
}
test('close immediately before labeling does not apply labels',t=>{
 const f=use(t,{atIssueRead:{4:{issue:{state:'closed'}}}});success(f.run('intake'));success(f.run('report'));
 assert.equal(f.writes().filter(x=>x.path.includes('/labels')).length,0);
 assert.match(f.read().comments[0].body,/Skipped/);
});
test('new owner at final PR publication is not overwritten',t=>{
 const f=use(t,{issue:{...issue,pull_request:{}},atIssueRead:{4:{newOwner:'5678:2'}}});success(f.run('intake'));success(f.run('report'));
 assert.equal(f.writes().length,1);assert.match(f.read().comments[0].body,/5678:2/);
});
test('API failures remain failures in intake, prepare and report',t=>{
 for(const mode of ['intake','prepare','report']){
  const f=use(t);if(mode!=='intake')success(f.run('intake'));
  f.update({failRead:'/issues/12'});assert.notEqual(f.run(mode).status,0);
  assert.equal(f.writes().length,mode==='intake'?0:1);
 }
});
test('genuine preparation failure stays failed after the target recovers',t=>{
 const f=use(t);success(f.run('intake'));f.update({failRead:'/issues/12'});
 assert.notEqual(f.run('prepare').status,0);f.update({failRead:false});
 assert.notEqual(f.run('report',{REVIEW_OUTCOME:'failure',REVIEW_PREPARED:'false'}).status,0);
 assert.match(f.read().comments[0].body,/Failed/);
 assert.equal(f.writes().filter(x=>x.path.includes('/labels')).length,0);
});
test('diff fetch failure is not reported as a size limit',t=>{
 const f=use(t,{issue:{...issue,pull_request:{}},failDiff:true});
 assert.notEqual(f.run('intake').status,0);assert.equal(f.writes().length,0);
});
test('result file lookup failure remains an API failure, not invalid model output',t=>{
 const f=use(t,{issue:{...issue,pull_request:{}}});success(f.run('intake'));f.update({failRead:'/files?'});
 const r=f.run('report');assert.notEqual(r.status,0);assert.equal(f.writes().length,1);
});
test('a report-only retry retains intake ownership across run attempts',t=>{
 const f=use(t,{issue:{...issue,pull_request:{}}});success(f.run('intake'));
 success(f.run('report',{GITHUB_RUN_ATTEMPT:'2'}));assert.match(f.read().comments[0].body,/Complete/);
 success(f.run('report',{GITHUB_RUN_ATTEMPT:'3'}));assert.equal(f.read().comments.length,1);
});
test('missing ownership cannot publish or prepare',t=>{
 const f=use(t);success(f.run('intake'));
 for(const mode of ['prepare','report']) assert.notEqual(f.run(mode,{REVIEW_OWNER:''}).status,0);
 assert.equal(f.writes().length,1);
});
test('cancelled model run is explicit and does not mutate labels',t=>{
 const f=use(t);success(f.run('intake'));success(f.run('report',{REVIEW_OUTCOME:'cancelled'}));
 assert.match(f.read().comments[0].body,/Cancelled/);assert.equal(f.writes().filter(x=>x.path.includes('/labels')).length,0);
});


test('prepare requires the public bot identity but no publishing credential',t=>{
 const f=use(t,{issue:{...issue,pull_request:{}}});success(f.run('intake'));
 const r=f.run('prepare',{REVIEW_BOT_ID:''});assert.notEqual(r.status,0);assert.match(r.stderr,/bot identity/);
 assert.equal(existsSync(join(f.dir,'summary')),false);
 const prepared=f.run('prepare',{REVIEW_WRITE_TOKEN:''});success(prepared);assert.equal(prepared.outputs.ready,'true');
});


test('child PR review pins the actual target and reads its delta without checking it out', t => {
 const parent='c'.repeat(40);
 const f=use(t,{issue:{...issue,pull_request:{}},pr:{...pr,base:{...pr.base,ref:'refactor/parent',sha:parent}},baseDiff:'+parent context\n'});
 success(f.run('intake'));success(f.run('prepare'));success(f.run('report'));
 const live=f.read(), receipt=latestReceipt(live.comments,98765);
 assert.deepEqual(receipt.base,{ref:'refactor/parent',sha:parent});
 assert.equal(receipt.fingerprint,fingerprintPR({...live.issue,...live.pr},live.main,live.comments,receipt.base));
 assert.equal(readFileSync(join(f.dir,'.review/base-changes.diff'),'utf8'),'+parent context\n');
 const calls=readFileSync(join(f.dir,'git.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls,[['-c','core.hooksPath=/dev/null','fetch','--no-tags','origin',parent],
  ['diff','--no-ext-diff','--no-textconv','--no-renames',main,parent,'--']]);
});
for (const stage of ['prepare','report']) test(`parent branch advancement invalidates child ${stage}`,t=>{
 const f=use(t,{issue:{...issue,pull_request:{}},pr:{...pr,base:{...pr.base,ref:'refactor/parent',sha:'c'.repeat(40)}}});
 success(f.run('intake'));f.update({baseSha:'d'.repeat(40)});success(f.run(stage));
 assert.match(readFileSync(join(f.dir,'summary'),'utf8'),/Outdated/);
 assert.doesNotMatch(f.read().comments[0].body,/State lost/);
});
test('base context fetch failure remains an infrastructure failure',t=>{
 const f=use(t,{issue:{...issue,pull_request:{}},pr:{...pr,base:{...pr.base,ref:'refactor/parent',sha:'c'.repeat(40)}},failFetch:true});
 success(f.run('intake'));assert.notEqual(f.run('prepare').status,0);
 assert.equal(existsSync(join(f.dir,'.review/input.json')),false);
});
for(const bytes of [250001,1100000]) test(`oversized base context (${bytes} bytes) reports scope without invoking the model`,t=>{
 const f=use(t,{issue:{...issue,pull_request:{}},pr:{...pr,base:{...pr.base,ref:'refactor/parent',sha:'c'.repeat(40)}},baseDiff:'x'.repeat(bytes)});
 success(f.run('intake'));const prep=f.run('prepare');success(prep);
 assert.equal(prep.outputs.ready,'false');assert.equal(prep.outputs.scope_limited,'true');
 assert.equal(existsSync(join(f.dir,'.review/input.json')),false);
 success(f.run('report',{REVIEW_PREPARED:'false',REVIEW_SCOPE_LIMITED:prep.outputs.scope_limited}));
 assert.match(f.read().comments[0].body,/Needs a smaller scope/);
 assert.doesNotMatch(f.read().comments[0].body,/Complete|State lost/);
});

test('evidence context is reviewed and published with a bound machine-readable assessment', t => {
  const owner = {...policy.trustedMaintainers[0], type: 'User'};
  const scopeIssue = {number: 73, title: 'Agreed work', body: 'Preserve history', state: 'open'};
  const record = {version: 1, head, scope: {issue: 73, approved: true, digest: scopeDigest(scopeIssue, [])},
    requirements: [{id: 'R1', expected: 'History persists'}], evidence: [{kind: 'automated', result: 'pass',
      requirements: ['R1'], reference: 'test run', details: 'Persistence assertions'}], product_decisions: []};
  const comment = {id: 40, user: owner, body: `${acceptanceMarker}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``};
  const f = use(t, {scopeIssue, comments: [comment], issue: {...issue, pull_request: {}},
    eventName: 'pull_request_target', event: {action: 'opened', pull_request: pr, sender: user}});
  success(f.run('intake'));
  const prepared = f.run('prepare', {REVIEW_CONTEXT: '1'}); success(prepared);
  assert.equal(prepared.outputs.ready, 'true');
  const context = JSON.parse(Buffer.from(prepared.outputs.context, 'base64url').toString());
  assert.equal(context.acceptance.status, 'ready');
  const assessment = {scope: 'aligned', device: 'not-required', requirements: [{id: 'R1', status: 'covered', reason: 'Test covers persistence'}], gaps: [], architecture: [], related: []};
  success(f.run('report', {REVIEW_CONTEXT_JSON: prepared.outputs.context, REVIEW_JSON: JSON.stringify({...result, findings: [], assessment})}));
  const receipt = latestReceipt(f.read().comments, 98765);
  assert.equal(receipt.quality.findings, 0); assert.equal(receipt.quality.acceptance.comment_id, 40);
  assert.equal(receipt.quality.assessment.requirements[0].id, 'R1');
  assert.match(f.read().comments.at(-1).body, /Physical verification: not-required/);
});

test('inline review edits invalidate an in-flight result', t => {
  const f = use(t, {issue: {...issue, pull_request: {}}, eventName: 'pull_request_target',
    event: {action: 'opened', pull_request: pr, sender: user}});
  success(f.run('intake')); success(f.run('prepare'));
  f.update({inlineComments: [{id: 15, user, body: 'A new concrete concern', updated_at: '2026-10-18', commit_id: head}]});
  success(f.run('report')); assert.match(f.read().comments.at(-1).body, /Outdated/);
});

test('trusted synchronize starts a review but another contributor cannot trigger that automatic path', t => {
  const owner = {...policy.trustedMaintainers[0], type: 'User'};
  for (const actor of [owner, user]) {
    const f = use(t, {issue: {...issue, user: owner, pull_request: {}}, eventName: 'pull_request_target',
      event: {action: 'synchronize', pull_request: pr, sender: actor}});
    const r = f.run('intake'); success(r);
    assert.equal(r.outputs.accepted, actor === owner ? 'true' : 'false');
  }
});

test('unsupported issue and PR relationships preserve technical findings without publishing invented links', t => {
  for (const isPR of [false, true]) {
    const f = use(t, isPR ? {issue: {...issue, body: 'Closes #73', pull_request: {}},
      eventName: 'pull_request_target', event: {action: 'opened', pull_request: pr, sender: user}} :
      {related: [{number: 30, title: 'History persistence', body: 'Related behavior', state: 'open'}]});
    success(f.run('intake'));
    const prepared = f.run('prepare', {REVIEW_CONTEXT: '1'}); success(prepared);
    const assessment = {scope: 'unknown', device: 'not-required', requirements: [], gaps: [], architecture: [],
      related: [{number: isPR ? 73 : 999, relationship: 'possibly-resolved', reason: 'Unsupported relationship'}]};
    success(f.run('report', {REVIEW_CONTEXT_JSON: prepared.outputs.context, REVIEW_JSON: JSON.stringify({...result, assessment})}));
    const body = f.read().comments.at(-1).body;
    assert.match(body, /Complete/); assert.match(body, /State lost/);
    assert.doesNotMatch(body, /Unsupported relationship/);
    const quality = JSON.parse(Buffer.from(body.match(/<!-- dot-link-review-quality:([A-Za-z0-9_-]+) -->/)[1], 'base64url').toString());
    assert.deepEqual(quality.assessment.related, []);
    assert.equal(quality.findings, result.findings.length);
  }
});

test('large valid assessments publish one explanation and a compact decision receipt', t => {
  const owner = {...policy.trustedMaintainers[0], type: 'User'};
  const scopeIssue = {number: 73, title: 'Agreed work', body: 'Ten required behaviors', state: 'open'};
  const requirements = Array.from({length: 10}, (_, i) => ({id: `R${i}`, expected: `Behavior ${i}`}));
  const record = {version: 1, head, scope: {issue: 73, approved: true, digest: scopeDigest(scopeIssue, [])}, requirements,
    evidence: [{kind: 'static', result: 'pass', requirements: requirements.map(x => x.id), reference: 'Source', details: 'Inspected behavior'}], product_decisions: []};
  const comment = {id: 40, user: owner, body: `${acceptanceMarker}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``};
  const f = use(t, {scopeIssue, comments: [comment], issue: {...issue, pull_request: {}},
    eventName: 'pull_request_target', event: {action: 'opened', pull_request: pr, sender: user}});
  success(f.run('intake'));
  const prepared = f.run('prepare', {REVIEW_CONTEXT: '1'}); success(prepared);
  const assessment = {scope: 'aligned', device: 'not-required', requirements: requirements.map(x => ({id: x.id, status: 'covered', reason: 'x'.repeat(3000)})), gaps: [], architecture: [], related: []};
  success(f.run('report', {REVIEW_CONTEXT_JSON: prepared.outputs.context, REVIEW_JSON: JSON.stringify({...result, findings: [], assessment})}));
  const body = f.read().comments.at(-1).body;
  assert.match(body, /Complete/); assert.ok(Buffer.byteLength(body) < 40000);
  const receipt = latestReceipt(f.read().comments, 98765);
  assert.equal(receipt.quality.assessment.requirements.length, 10);
  assert.equal(receipt.quality.assessment.requirements[0].status, 'covered');
});

test('sanitization expansion fails visibly before an oversized comment is posted', t => {
  const f = use(t); success(f.run('intake')); success(f.run('prepare'));
  const oversized = {...result, summary: '@'.repeat(11000), next_steps: '@'.repeat(11000), limitations: '@'.repeat(11000)};
  assert.notEqual(f.run('report', {REVIEW_JSON: JSON.stringify(oversized)}).status, 0);
  assert.match(f.read().comments.at(-1).body, /Failed/);
  assert.ok(Buffer.byteLength(f.read().comments.at(-1).body) < 2000);
});

test('workflow concurrency keeps non-acting events out of the authorized item queue', () => {
  const expression = workflow.match(/group: >-\n\s+opus-review-\$\{\{([\s\S]*?)\}\}/)[1];
  // The expression uses only JS-equivalent boolean/equality operators and these
  // documented Actions functions. Exercise the real YAML, including ID drift.
  const evaluate = new Function('github', 'inputs', 'format', 'fromJSON', 'contains', 'startsWith', `return (${expression});`);
  const group = (eventName, event) => evaluate({event_name: eventName, run_id: 999, ref: 'refs/heads/main', event: {issue: {}, pull_request: {}, ...event}}, {},
    (pattern, value) => pattern.replace('{0}', String(value)), JSON.parse, (xs, x) => xs.includes(x),
    (value, prefix) => typeof value === 'string' && value.startsWith(prefix));
  for (const owner of policy.trustedMaintainers) {
    const sender = {...owner, type: 'User'};
    assert.equal(group('pull_request_target', {sender, action: 'synchronize', pull_request: {number: 12, draft: false, user: sender}}), 'item-12');
    assert.equal(group('issue_comment', {sender, issue: {number: 12, user: sender}, comment: {user: sender, body: '/dotlink review'}}), 'item-12');
    assert.equal(group('issue_comment', {sender, issue: {number: 12, user: sender}, comment: {user: sender, body: acceptanceMarker}}), 'item-12');
  }
  assert.equal(group('pull_request_target', {sender: user, action: 'synchronize', pull_request: {number: 12, draft: false, user}}), 'ignored-999');
  for (const body of ['Ordinary comment', '/dotlink review ', acceptanceMarker]) {
    assert.equal(group('issue_comment', {sender: user, issue: {number: 12, user}, comment: {user, body}}), 'ignored-999');
  }
  assert.equal(group('issue_comment', {sender: {...user, type: 'Bot'}}), 'ignored-999');
  assert.equal(group('issue_comment', {sender: user, issue: {number: 12, user}, comment: {user: {id: 456}, body: '/dotlink review'}}), 'ignored-999');
});

test('stale-head requirement IDs become explicit gaps without discarding technical findings', t => {
  const owner = {...policy.trustedMaintainers[0], type: 'User'};
  const record = {version: 1, head: main, scope: {issue: 73, approved: true, digest: 'a'.repeat(64)},
    requirements: [{id: 'R1', expected: 'Preserve history'}], evidence: [], product_decisions: []};
  const comment = {id: 40, user: owner, body: `${acceptanceMarker}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``};
  const f = use(t, {comments: [comment], issue: {...issue, pull_request: {}}, eventName: 'pull_request_target',
    event: {action: 'opened', pull_request: pr, sender: user}});
  success(f.run('intake')); const prepared = f.run('prepare', {REVIEW_CONTEXT: '1'}); success(prepared);
  const assessment = {scope: 'aligned', device: 'not-required', requirements: [{id: 'R1', status: 'covered', reason: 'Old claim'}], gaps: [], architecture: [], related: []};
  success(f.run('report', {REVIEW_CONTEXT_JSON: prepared.outputs.context, REVIEW_JSON: JSON.stringify({...result, assessment})}));
  const body = f.read().comments.at(-1).body;
  assert.match(body, /Complete/); assert.match(body, /State lost/); assert.match(body, /R1 — gap/);
  assert.match(body, /not in a current acceptance record/);
  assert.equal(latestReceipt(f.read().comments, 98765).quality.assessment.scope, 'unknown');
});
