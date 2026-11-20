import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ArchiveAuthority } from '../server/history/archive-authority.ts';
import { readFactorHistory } from '../server/history/factor-tool.ts';
import { historyExpiry } from '../server/history/retention.ts';
import { LocationHistoryStore } from '../server/history/store.ts';
import type { GeographicEvidence } from '../server/geography/types.ts';

const owner = 'a'.repeat(64);
const other = 'b'.repeat(64);
const day = 86_400_000;
const start = Date.parse('2026-01-02T12:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const fix = (time: number, speed = 1) => ({latitude:10, longitude:20, accuracy:8, measured_at:iso(time), speed, heading:90});
const geography = (release: string): GeographicEvidence => ({source:'Synthetic map', release, attribution:'Test', license_url:'https://maps.example.test/license',
  lines:[{id:'road', kind:'road', relation:'near', distance_m:42}], areas:[], landmarks:[], limitations:['Partial.']});

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'long-location-'));
  const legacy = join(directory, 'location');
  const protectedDir = join(directory, 'protected');
  const sources = join(protectedDir, 'sources');
  let clock = start, allowed = owner, created = 0;
  const testKey = randomBytes(32);
  let history: LocationHistoryStore;
  const createAuthority = () => new ArchiveAuthority(protectedDir, {
    async create() { created++; return {wrapped:'synthetic-wrap', key:Buffer.from(testKey)}; },
    async open(wrapped) { assert.equal(wrapped, 'synthetic-wrap'); return Buffer.from(testKey); },
  }, {now:() => clock, ownerStatus:id => id === allowed ? 'authorized' : 'revoked', locationContinuity:() => history?.continuity()});
  let authority = createAuthority();
  const open = (archiving: boolean) => new LocationHistoryStore(legacy, {now:() => clock, ownerAuthorized:id => id === allowed,
    ownerRevoked:id => id !== allowed, announce:async () => {}, ...(archiving ? {archive:() => authority} : {})});
  history = open(true);
  const legacyControl = (action: string) => history.control({protocol:1, epoch:history.status(allowed).historyEpoch, action}, allowed);
  async function change(input: Parameters<ArchiveAuthority['control']>[2]) {
    const before = await authority.status(allowed);
    return authority.control(allowed, before.epoch, input);
  }
  const archive = (enabled=true) => change({action:'set', source:'location', enabled});
  const interval = (a: number, b: number, fields=['motion'], limit=10) => ({start_at:iso(a), end_at:iso(b), fields, limit});
  const page = (a: number, b: number, fields=['motion'], limit=10) => history.readSelectedHistory(interval(a,b,fields,limit));
  const upload = (time = clock, speed = 1, offset = 0) => history.ingest(fix(time,speed), 'recording',
    {protocol:1, epoch:history.status(allowed).historyEpoch, timezone:offset ? 'Asia/Bangkok' : 'Etc/UTC', utc_offset_minutes:offset}, allowed);
  async function restart(archiving=true) {
    history.close(); authority.close();
    authority = createAuthority();
    history = open(archiving);
    if (archiving) await authority.restore();
  }
  t.after(() => { history.close(); authority.close(); testKey.fill(0); rmSync(directory, {recursive:true, force:true}); });
  return {get history(){return history;}, get authority(){return authority;}, get keys(){return created;}, get now(){return clock;},
    legacy, protectedDir, sources, legacyControl, archive, page, upload, interval, restart, change, at(time:number){clock=time;}, owner(id:string){allowed=id;}};
}

test('seven-day users keep their grant and data without provisioning, enabling the extension admits new fixes only', async t => {
  const f = fixture(t);
  f.legacyControl('enable'); f.at(start+1000);
  assert.equal(f.upload(),true);
  assert.equal(f.keys,0);
  assert.equal(existsSync(f.sources),false);
  f.at(start+2000); await f.archive(); await f.change({action:'period',period:'1m'});
  f.at(start+3000); assert.equal(f.upload(),true);
  const entryWindow = f.interval(start,start+4000,['motion'],1);
  f.at(start+4000);
  const first = readFactorHistory({...entryWindow,fields:{location:['motion']}},{location:f.history},f.now).sources.location!;
  assert.equal(first.entries.length,1); assert.ok(first.next_cursor); assert.ok(first.response_context);
  const second = readFactorHistory({source:'location',cursor:first.next_cursor},{location:f.history},f.now).sources.location!;
  const measured = [...first.entries,...second.entries].map(row => (row as {measured_at:string}).measured_at).sort();
  assert.deepEqual(measured,[iso(start+1000),iso(start+3000)]);
  assert.ok(!JSON.stringify([first,second]).includes('"latitude"'));
  assert.equal(second.next_cursor,null);
  assert.equal(f.history.responseGuard(first.response_context.arguments.history_context_ids![0])(),true);
  await f.restart();
  assert.equal(f.keys,1);
  f.at(start+8*day); assert.equal(f.history.status(owner).historyCount,0);
  assert.deepEqual(f.page(start,start+4000).entries.map(x=>'measured_at' in x ? x.measured_at : undefined),[iso(start+3000)]);
  assert.equal(f.upload(start+1000),false);
  assert.deepEqual(f.page(start,start+4000).entries.map(x=>'measured_at' in x ? x.measured_at : undefined),[iso(start+3000)]);
});

test('immutable fix, deadline and geography persist through later periods, expiry, and first late uploads', async t => {
  const f = fixture(t); f.legacyControl('enable'); await f.archive(); await f.change({action:'period',period:'1m'});
  const original=start+1000; f.at(original); assert.ok(f.upload());
  f.history.attachGeography(fix(original),geography('edition-1'),owner);
  f.at(original+day); f.history.attachGeography(fix(original),geography('corrected-edition'),owner);
  f.at(start+9*day);
  const atReceipt = f.now;
  const delayed=start+2000; assert.ok(f.upload(delayed,2,420));
  assert.equal(f.history.status(owner).historyCount,0);
  const before = f.page(original,original+1,['geography','motion']);
  assert.match(JSON.stringify(before.entries),/corrected-edition/); assert.ok('history_context_id' in before);
  const guard=f.history.responseGuard(before.history_context_id); assert.ok(guard());
  await f.change({action:'period',period:'1y'});
  assert.throws(guard); assert.equal(f.upload(original,99),false);
  f.history.attachGeography(fix(original),geography('stale edition'),owner);
  assert.doesNotMatch(JSON.stringify(f.page(original,original+1,['geography']).entries),/stale edition/);
  const date=iso(atReceipt).slice(0,10), clock=f.history.readPhoneTime([date],owner);
  assert.equal(clock.evidence.status,'available'); assert.ok('by_source_date' in clock.evidence);
  assert.equal(clock.evidence.by_source_date[0].reference.utc_offset_minutes,420);
  assert.equal(clock.evidence.by_source_date[0].observation_count,1);
  assert.ok(!JSON.stringify(clock).includes('latitude'));
  f.at(historyExpiry(original,'1m')-1);
  const almost = f.page(original,original+1); assert.ok('history_context_id' in almost);
  const last=f.history.responseGuard(almost.history_context_id); assert.ok(last());
  f.at(historyExpiry(original,'1m')); assert.throws(last); assert.equal(f.page(original,original+1).status,'empty');
  assert.equal(f.upload(original,99),false); assert.equal(f.page(original,original+1).status,'empty');
});

test('old-build disable and re-enable leave long retention off; old delete and re-enable retire its key', async t => {
  const f=fixture(t); f.legacyControl('enable'); await f.archive(); await f.change({action:'period',period:'1y'});
  const point=start+1000; f.at(point); f.upload();
  const oldName=readdirSync(f.sources).find(file=>file.endsWith('.sqlite'))!;
  const backup=readFileSync(join(f.sources,oldName));
  await f.restart(false); f.legacyControl('disable'); f.legacyControl('enable');
  await f.restart();
  assert.equal((await f.authority.status(owner)).sources.location,false);
  f.at(point+8*day); assert.equal(f.page(point,point+1).entries.length,0);
  await f.archive(); assert.equal(f.page(point,point+1).entries.length,1);
  await f.restart(false); f.legacyControl('delete'); f.legacyControl('enable');
  await f.restart(); assert.equal((await f.authority.status(owner)).sources.location,false);
  assert.ok(!existsSync(join(f.sources,oldName)));
  writeFileSync(join(f.sources,oldName),backup,{mode:0o600});
  await f.archive(); assert.equal(f.page(point,point+1).entries.length,0);
  assert.equal(f.upload(point),false);
});

test('interrupted duplicate marking, stale owner, lost cursors and archive deletion are handled through the selected reader',async t=>{
  const f=fixture(t); f.legacyControl('enable'); await f.archive(); await f.change({action:'period',period:'6m'});
  for(let i=1;i<=3;i++){f.at(start+i*1000);assert.ok(f.upload());}
  const db=new DatabaseSync(join(f.legacy,'history.sqlite'));
  try {db.prepare('UPDATE observations SET archive_generation=NULL, archive_stamp=NULL WHERE measured=?').run(start+2000);}finally{db.close();}
  const rows=f.page(start,start+4000).entries; assert.equal(rows.length,3); assert.equal(new Set(rows.map(x=>x.id)).size,3);
  const page=f.page(start,start+4000,['clock'],1);assert.ok('history_context_id' in page);assert.ok(page.next_cursor);
  const guard=f.history.responseGuard(page.history_context_id);assert.ok(guard());
  await f.change({action:'delete',source:'location'});assert.throws(guard);
  assert.throws(()=>f.history.readSelectedHistory({cursor:page.next_cursor!}));
  assert.equal(f.page(start,start+4000).entries.length,3);
  await f.archive(); f.at(start+5000); f.upload();
  const last=f.page(start,start+6000);assert.ok('history_context_id' in last);
  const oldOwner=f.history.responseGuard(last.history_context_id);assert.ok(oldOwner());f.owner(other);assert.throws(oldOwner);
  await f.authority.restore();assert.equal((await f.authority.status(other)).sources.location,false);
  assert.equal(f.history.status(other).historyCount,0);assert.equal(f.history.readPhoneTime([iso(start).slice(0,10)],owner).evidence.status,'unavailable');
});

test('phone clock merges same-day copies once and invalidates at grant stop; different offsets remain ambiguous',async t=>{
  const f=fixture(t);f.legacyControl('enable');f.at(start+1000);f.upload();
  f.at(start+2000);await f.archive();await f.change({action:'period',period:'1y'});f.at(start+3000);f.upload(f.now,1,420);
  const date=iso(start).slice(0,10), result=f.history.readPhoneTime([date],owner);
  assert.ok('by_source_date' in result.evidence);const selected=result.evidence.by_source_date[0];
  assert.equal(selected.observation_count,2);assert.equal(selected.reference.status,'ambiguous');
  assert.equal(result.allowed?.(),true);await f.archive(false);assert.equal(result.allowed?.(),false);
});

test('one paired panel operation commits both grants, rejects stale actors and leaves other sources intact', async t => {
  const f = fixture(t);
  const on = {action:'set', source:'location', enabled:true} as const;
  const off = {...on, enabled:false};
  const erase = {action:'delete', source:'location'} as const;
  const unrelated = await f.change({action:'set', source:'weather', enabled:true});
  const competing = await Promise.allSettled([
    f.history.controlArchive(owner, unrelated.epoch, on),
    f.history.controlArchive(owner, unrelated.epoch, on),
  ]);
  assert.equal(competing.filter(r => r.status === 'fulfilled').length,1);
  assert.equal(f.history.status(owner).historyEnabled,true);
  const before = await f.authority.status(owner);
  assert.deepEqual(before.sources,{location:true, weather:true, mobility:false});
  f.at(start+1000); assert.ok(f.upload());
  const page = f.page(start,start+2000); assert.ok('history_context_id' in page);
  const guard = f.history.responseGuard(page.history_context_id);
  await assert.rejects(() => f.history.controlArchive(other,before.epoch,off));
  await assert.rejects(() => f.history.controlArchive(owner,unrelated.epoch,erase));
  assert.ok(guard());
  const stopped = await f.history.controlArchive(owner,before.epoch,off);
  assert.equal(stopped.sources.location,false); assert.equal(f.history.status(owner).historyEnabled,false);
  assert.equal(f.history.status(owner).historyCount,1); assert.throws(guard);
  const resumed = await f.history.controlArchive(owner,stopped.epoch,on);
  assert.equal(f.page(start,start+2000).entries.length,1);
  const erased = await f.history.controlArchive(owner,resumed.epoch,erase);
  assert.equal(erased.sources.weather,true);
  assert.equal(erased.sources.location,false);
  assert.equal(f.history.status(owner).historyCount,0);
  assert.equal(f.history.status(owner).historyEnabled,false);
  await f.restart();
  assert.equal((await f.authority.status(owner)).sources.location,false);
  assert.equal(f.history.status(owner).historyCount,0);
});

test('a protected policy write failure rolls the recent consent and evidence back, then the same request can retry', async t => {
  const f = fixture(t);
  const on = {action:'set',source:'location',enabled:true} as const;
  const erase = {action:'delete',source:'location'} as const;
  const start = await f.authority.status(owner);
  const both = await f.history.controlArchive(owner,start.epoch,on);
  f.at(f.now+1000); assert.ok(f.upload());
  const db = new DatabaseSync(join(f.protectedDir,'authority.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_location_test BEFORE UPDATE ON authority BEGIN SELECT RAISE(ABORT,'test fault'); END");
    await assert.rejects(() => f.history.controlArchive(owner,both.epoch,erase));
    assert.equal(f.history.status(owner).historyEnabled,true);
    assert.equal(f.history.status(owner).historyCount,1);
    assert.equal((await f.authority.status(owner)).epoch,both.epoch);
    db.exec('DROP TRIGGER fail_location_test');
    const deleted = await f.history.controlArchive(owner,both.epoch,erase);
    assert.equal(deleted.sources.location,false);
    assert.equal(f.history.status(owner).historyCount,0);
  } finally { db.close(); }
});

test('the panel can stop or erase legacy-only records without creating a protected key or enabling a source', async t => {
  const f = fixture(t); f.legacyControl('enable'); f.at(f.now+1000); assert.ok(f.upload());
  const first = await f.authority.status(owner);
  const off = await f.history.controlArchive(owner,first.epoch,{action:'set',source:'location',enabled:false});
  assert.notEqual(off.epoch,first.epoch);
  assert.equal(f.history.status(owner).historyEnabled,false);
  assert.equal(f.history.status(owner).historyCount,1);
  const removed = await f.history.controlArchive(owner,off.epoch,{action:'delete',source:'location'});
  assert.notEqual(removed.epoch,off.epoch);
  assert.equal(f.keys,0); assert.equal(f.history.status(owner).historyCount,0);
});

test('a panel opened before a legacy permission change or restart cannot enable longer retention', async t => {
  const f = fixture(t); const on = {action:'set',source:'location',enabled:true} as const;
  const blank = await f.authority.status(owner);
  f.legacyControl('enable');
  await assert.rejects(() => f.history.controlArchive(owner,blank.epoch,on));
  const beforeErase = await f.authority.status(owner);
  f.legacyControl('delete');
  await assert.rejects(() => f.history.controlArchive(owner,beforeErase.epoch,on));
  assert.equal(f.keys,0);
  const current = await f.authority.status(owner);
  const set = await f.history.controlArchive(owner,current.epoch,on);
  await f.restart();
  await assert.rejects(() => f.history.controlArchive(owner,set.epoch,{...on,enabled:false}));
  assert.equal((await f.authority.status(owner)).sources.location,true);
});

test('unreadable protected file reports incomplete coverage and keeps permitted recent fields usable', async t => {
  const f = fixture(t); f.legacyControl('enable'); await f.archive(); f.at(start+1000); f.upload();
  const file = join(f.sources, readdirSync(f.sources).find(name => name.endsWith('.sqlite'))!);
  const backup = readFileSync(file);
  writeFileSync(file,Buffer.alloc(0));
  const fallback = f.page(start,start+2000,['motion']);
  assert.equal(fallback.status,'partial'); assert.equal(fallback.entries.length,1);
  assert.doesNotMatch(JSON.stringify(fallback.entries),/latitude|longitude/);
  writeFileSync(file,backup);
  assert.equal(f.page(start,start+2000).status,'available');
});
