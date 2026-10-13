import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const source = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
const zip = 'test archive';
const hash = createHash('sha256').update(zip).digest('hex');
const url = 'https://github.com/YusukeIt0/dot-link/releases/download/mac-v9.8.7-999/Dot-Link-9.8.7-999-arm64.zip';
const release = () => ({draft:false, prerelease:false, tag_name:'mac-v9.8.7-999', body:null, assets:[
  {name:'unrelated.txt',label:null}, {name:'Dot-Link-9.8.7-999-arm64.zip', browser_download_url:url, digest:`sha256:${hash}`},
]});
function run(metadata, {existing=false, badSignature=false, language='en-US', bundleId='app.tripsurf.dotlink.mac'}={}) {
  const root = mkdtempSync(join(tmpdir(), 'dot-link-installer-test-'));
  try {
    const bin=join(root,'bin'), destination=join(root,'Applications','Dot Link.app');
    mkdirSync(bin); mkdirSync(join(root,'tmp'));
    writeFileSync(join(root,'release.json'),JSON.stringify(metadata));
    writeFileSync(join(root,'archive'),zip);
    writeFileSync(join(root,'Info.plist'),JSON.stringify({CFBundleIdentifier:bundleId}));
    const mock=(name,body)=>writeFileSync(join(bin,name),'#!/bin/bash\nset -eu\n'+body+'\n',{mode:0o755});
    mock('defaults',`printf '(\\n    \"${language}\"\\n)\\n'`);
    mock('uname','echo Darwin'); mock('sysctl','echo 1'); mock('sw_vers','echo 13.0');
    mock('curl',`printf '%s\\n' "$*" >> '${root}/requests'\nwhile [ "$1" != --output ]; do shift; done\ncase "$2" in release.json) cp '${root}/release.json' "$2" ;; Dot-Link.zip) cp '${root}/archive' "$2" ;; *) exit 9 ;; esac`);
    mock('ditto',`mkdir -p 'unpacked/Dot Link.app/Contents'
cp '${root}/Info.plist' 'unpacked/Dot Link.app/Contents/Info.plist'`);
    mock('codesign',badSignature?'exit 1':'exit 0');
    mock('open',`printf '%s' "$1" > '${root}/opened'`);
    if(existing) mkdirSync(destination,{recursive:true});
    const script=join(root,'install.sh');
    writeFileSync(script,source.replaceAll('$HOME/Applications',`${root}/Applications`));
    const result=spawnSync('/bin/bash',[script],{encoding:'utf8',env:{...process.env,PATH:`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,TMPDIR:join(root,'tmp')}});
    return {...result, installed:existsSync(destination), opened:existsSync(join(root,'opened')), requests:existsSync(join(root,'requests'))?readFileSync(join(root,'requests'),'utf8'):''};
  } finally {rmSync(root,{recursive:true,force:true});}
}
test('both languages use the same short installer command without a pinned release',()=>{
  const blocks=['mac-install.md','mac-install.ja.md'].map(name=>readFileSync(new URL(`../docs/${name}`,import.meta.url),'utf8').match(/```sh\n([^]*?)\n```/)[1]);
  assert.equal(blocks[0],blocks[1]); assert.equal(blocks[0].split('\n').length,1);
  assert.match(blocks[0],/\/main\/install\.sh/); assert.doesNotMatch(blocks[0],/mac-v\d/);
});
test('installer resolves a future stable version and its matching checksum', {skip:process.platform!=='darwin'},()=>{
  const r=run(release()); assert.equal(r.status,0,r.stderr); assert.ok(r.installed&&r.opened);
  assert.match(r.requests,/releases\/latest/); assert.ok(r.requests.includes(url));
});
test('installer stops before installation for unsafe or unavailable release data', {skip:process.platform!=='darwin'},()=>{
  const cases=[];
  for(const key of ['draft','prerelease']) {const m=release();m[key]=true;cases.push(m);}
  {const m=release();m.assets=[];cases.push(m);}
  {const m=release();m.assets.push(m.assets[1]);cases.push(m);}
  {const m=release();m.assets[1].digest='sha256:'+'0'.repeat(64);cases.push(m);}
  {const m=release();m.assets[1].digest=null;cases.push(m);}
  {const m=release();m.assets[1].browser_download_url='https://example.com/app.zip';cases.push(m);}
  for(const m of cases) {const r=run(m);assert.notEqual(r.status,0);assert.equal(r.installed,false);assert.equal(r.opened,false);}
  for(const opts of [{badSignature:true},{bundleId:'com.example.other'}]) {const r=run(release(),opts);assert.notEqual(r.status,0);assert.equal(r.installed,false);assert.equal(r.opened,false);}
});
test('existing app is preserved without downloading', {skip:process.platform!=='darwin'},()=>{
  const r=run(release(),{existing:true});assert.notEqual(r.status,0);assert.equal(r.requests,'');assert.ok(r.installed);assert.equal(r.opened,false);
});

test('installer follows macOS language with English fallback', {skip:process.platform!=='darwin'},()=>{
  const ja=run(release(),{language:'ja-JP'});assert.equal(ja.status,0,ja.stderr);assert.match(ja.stdout,/最新の正式版/);
  const other=run(release(),{language:'fr-FR'});assert.equal(other.status,0,other.stderr);assert.match(other.stdout,/latest stable/);
});
