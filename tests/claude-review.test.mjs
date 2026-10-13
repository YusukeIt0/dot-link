import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const script = resolve('scripts/claude-review.mjs');
const main = 'a'.repeat(40), head = 'b'.repeat(40);
const user = {id: 123, login: 'contributor', type: 'User'};
const issue = {number: 12, title: 'History disappears', body: 'After reopening the app', state: 'open', locked: false, user};
const pr = {number: 12, state: 'open', draft: false, changed_files: 1,
  base: {ref: 'main', sha: main}, head: {sha: head, repo: {full_name: 'external/fork'}}};
const result = {summary: 'Review complete', findings: [{severity: 'medium', file: 'src/main.ts', line: 7,
  title: 'State lost', reason: 'Saved state is overwritten'}], next_steps: 'Verify persistence', limitations: 'Static review only'};
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dot-review-test-'));
  const data = {issue, pr, main, comments: [], permission: 'read', diff: '+new line\n', ...options};
  const event = options.event || {action: 'opened', issue: data.issue, sender: user};
  writeFileSync(join(dir, 'event.json'), JSON.stringify(event));
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2), p = a[1];
const f = JSON.parse(fs.readFileSync('fixture.json'));
if(a.includes('--input')) {
 const body = JSON.parse(fs.readFileSync(0, 'utf8'));
 fs.appendFileSync('writes.jsonl', JSON.stringify({path:p,body})+'\\n');
 const row = {id:999,user:{id:41898282,login:'github-actions[bot]',type:'Bot'},body:body.body,html_url:'https://github.com/YusukeIt0/dot-link/issues/12#issuecomment-999'};
 if(p.endsWith('/comments/999')) f.comments=f.comments.filter(x=>x.id!==999);
 f.comments.push(row); fs.writeFileSync('fixture.json',JSON.stringify(f));
 console.log(JSON.stringify(row));
} else if(a.includes('Accept: application/vnd.github.diff')) process.stdout.write(f.diff);
else if(p.endsWith('/commits/main')) console.log(JSON.stringify({sha:f.main}));
else if(p.includes('/comments?')) console.log(JSON.stringify([f.comments]));
else if(p.includes('/issues/comments/')) console.log(JSON.stringify(f.command));
else if(p.includes('/collaborators/')) console.log(JSON.stringify({permission:f.permission}));
else if(p.includes('/files?')) console.log(JSON.stringify([{filename:'src/main.ts'}]));
else if(p.includes('/pulls/')) console.log(JSON.stringify(f.pr));
else console.log(JSON.stringify(f.issue));
`, {mode: 0o700});
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(data));
  let outputs = {};
  const run = (mode, env = {}) => {
    writeFileSync(join(dir, 'output'), '');
    const r = spawnSync(process.execPath, [script, mode], {cwd: dir, encoding: 'utf8', env: {
      ...process.env, PATH: dir + ':' + process.env.PATH,
      GITHUB_REPOSITORY: 'YusukeIt0/dot-link', GITHUB_EVENT_PATH: join(dir, 'event.json'),
      GITHUB_EVENT_NAME: options.eventName || 'issues', GITHUB_RUN_ID: '1234', ITEM_NUMBER: '12',
      GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      REVIEW_FINGERPRINT: outputs.fingerprint, REVIEW_MAIN_SHA: outputs.main_sha,
      REVIEW_OUTCOME: 'success', REVIEW_JSON: JSON.stringify(result), ...env,
    }});
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
  assert.equal(f.writes()[1].path, 'repos/YusukeIt0/dot-link/issues/comments/999');
});
test('external fork PR is accepted; no contributor checkout or execution occurs', t => {
  const f=use(t, {issue:{...issue,pull_request:{}}, eventName:'pull_request_target', event:{action:'opened',pull_request:pr,sender:user}});
  success(f.run('intake')); success(f.run('prepare')); success(f.run('report'));
  assert.match(f.read().comments[0].body, /src\/main.ts:7/);
  assert.match(readFileSync(join(f.dir,'.review/changes.diff'),'utf8'), /new line/);
});
test('draft, closed, locked or non-main items do not start a review', t => {
  for(const opts of [{issue:{...issue,state:'closed'}},{issue:{...issue,locked:true}},
    {issue:{...issue,pull_request:{}},pr:{...pr,draft:true}},
    {issue:{...issue,pull_request:{}},pr:{...pr,base:{...pr.base,ref:'other'}}}]) {
    const f=use(t,opts); const r=f.run('intake'); success(r); assert.equal(r.outputs.accepted,'false'); assert.equal(f.writes().length,0);
  }
});
test('only author or write-access maintainer can request another review', t => {
  const other={id:456,login:'other',type:'User'};
  for(const [actor, permission, accepted] of [[user,'read',true],[other,'read',false],[other,'write',true]]) {
    const command={id:77,user:actor,body:'/opus review',issue_url:'https://api.github.com/repos/YusukeIt0/dot-link/issues/12'};
    const f=use(t,{eventName:'issue_comment',event:{action:'created',issue,sender:actor,comment:command},command,permission});
    const r=f.run('intake'); success(r); assert.equal(r.outputs.accepted,String(accepted));
  }
});
test('edited command, wrong destination and bot sender cannot trigger a review', t => {
  const command={id:77,user,body:'/opus review',issue_url:'https://api.github.com/repos/YusukeIt0/dot-link/issues/12'};
  for(const update of [{command:{...command,body:'cancel'}},{command:{...command,issue_url:'https://api.github.com/repos/other/repo/issues/12'}},
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
    const f=use(t); success(f.run('intake')); success(f.run('report',env));
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
  const r=f.run('report',{GITHUB_RUN_ID:'5678'}); assert.notEqual(r.status,0); assert.equal(f.writes().length,1);
});
test('invalid identifiers and changed preparation snapshot are rejected', t => {
  const f=use(t); assert.notEqual(f.run('intake',{ITEM_NUMBER:'12;echo bad'}).status,0);
  success(f.run('intake')); assert.notEqual(f.run('prepare',{REVIEW_FINGERPRINT:'stale'}).status,0);
});
