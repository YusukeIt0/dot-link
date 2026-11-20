import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, {type TestContext} from 'node:test';
import { PolarHistoryArchive } from '../server/health/archive.ts';
import { type Category, type Observation } from '../server/health/data.ts';
import { historyExpiry } from '../server/history/retention.ts';

const start = Date.parse('2024-01-31T12:00:00Z');
const day = 86_400_000;
function row(id: string, time = start, received = time, category: Category = 'recovery'): Observation {
  return {id:createHash('sha256').update(id).digest('hex'), source:'Polar', category, time_basis:'source_offset',
    measured_at:new Date(time).toISOString(), retention_anchor:time, retrieved_at:new Date(received).toISOString(),
    values:{heart_rate_avg:64}};
}
function fixture(t: TestContext, options = {slots: 8, pageBytes: 16_384, indexBytes: 16384}) {
  const dir = mkdtempSync(join(tmpdir(), 'polar-history-'));
  const path = join(dir, 'archive.sqlite'), key = randomBytes(32);
  let clock = start;
  const active = new Set<PolarHistoryArchive>();
  const open = (create = false, material = key) => {
    const archive = new PolarHistoryArchive(path, material, {...options, now: () => clock, create});
    active.add(archive); return archive;
  };
  const close = (archive: PolarHistoryArchive) => { archive.close(); active.delete(archive); };
  t.after(() => {for (const archive of active) archive.close(); rmSync(dir, {recursive:true,force:true});});
  function shape() {
    const db = new DatabaseSync(path, {readOnly:true});
    try { return {size:statSync(path).size, sizes: db.prepare('SELECT length(body) bytes,count(*) n FROM pages GROUP BY length(body) ORDER BY bytes').all()}; }
    finally { db.close(); }
  }
  const query = {startMs:start-1,endMs:start+1};
  return {path,dir,open,close,shape,key,query, time(ms: number) {clock = ms;}};
}

test('fixed authenticated slots conceal occupancy, categories, values, dates and the logical index across restart', t => {
  const f = fixture(t);
  let archive = f.open(true);
  const empty = f.shape(), item = row('fixture');
  item.values.sport = 'private-synthetic-sport';
  assert.equal(archive.put([item], '1y').stored, 1);
  assert.deepEqual(f.shape(), empty);
  const bytes = readFileSync(f.path);
  for (const token of [item.id, item.measured_at!, 'Polar', 'recovery', 'private-synthetic-sport', 'heart_rate_avg'])
    assert.equal(bytes.includes(Buffer.from(token)), false);
  assert.deepEqual(readdirSync(f.dir), ['archive.sqlite']);
  f.close(archive);
  assert.throws(() => f.open(false, randomBytes(32)));
  archive = f.open();
  assert.deepEqual(archive.read(f.query).records[0].observation, item);
  f.time(historyExpiry(start, '1y'));
  assert.deepEqual(archive.read(f.query).records, []);
  assert.equal(archive.prune(), 1);
  assert.deepEqual(f.shape(), empty);
});

test('calendar deadlines survive duplicates/corrections and neither extension nor late delivery resurrects expired data', t => {
  const f = fixture(t), archive = f.open(true);
  const item = row('identity');
  archive.put([item], '1m');
  f.time(start + day);
  const correction = {...item, retrieved_at:new Date(start + day).toISOString(), values: {heart_rate_avg: 68}};
  assert.equal(archive.put([correction], '1y').corrected, 1);
  assert.equal(archive.put([item], '1y').duplicate, 1);
  const final = archive.read(f.query).records[0];
  assert.equal(final.expiresAtMs, Date.parse('2024-02-29T12:00:00Z'));
  assert.equal(final.firstReceivedMs, start);
  assert.equal(final.period, '1m');
  assert.equal(final.observation.values.heart_rate_avg, 68);
  const second = row('new-one', start + day);
  archive.put([second], '7d');
  f.time(final.expiresAtMs);
  assert.equal(archive.read(f.query).records.length, 0);
  archive.prune();
  assert.equal(archive.put([correction], '1y').expired, 1);
  const arrivedLate = row('late', start, final.expiresAtMs);
  assert.equal(archive.put([arrivedLate], '7d').expired, 1);
  assert.equal(archive.put([arrivedLate], '1y').expired, 1);
});

test('daily uncertainty, half-open sleep overlap and projection category remain distinct', t => {
  const f=fixture(t), archive=f.open(true);
  const sleep = row('night', start - 4*3600_000, start, 'sleep');
  sleep.values.sleep_end_time = new Date(start + 100).toISOString();
  const daily = row('day', start - 26*3600_000, start, 'activity');
  daily.source_local_date = '2024-01-31'; daily.measured_at = null; daily.time_basis = 'local_date_earliest_bound';
  daily.values = {steps: 1000};
  archive.put([sleep,daily], '6m');
  assert.deepEqual(archive.read({...f.query, categories:['sleep']}).records.map(r => r.observation.id), [sleep.id]);
  assert.deepEqual(archive.read({startMs:start+100,endMs:start+101,categories:['sleep']}).records, []);
  const nextDay = archive.read({startMs:start+day-1,endMs:start+day,categories:['activity']}).records;
  assert.equal(nextDay.length, 1); assert.equal(nextDay[0].observation.measured_at, null);
  assert.equal(nextDay[0].observation.values.steps, 1000);
  assert.deepEqual(archive.read({startMs:start+day,endMs:start+day+1,categories:['activity']}).records, []);
});

test('bounded pagination survives reopening, binds filters and expires on correction', t => {
  const f=fixture(t), first=f.open(true), second=f.open();
  const records=Array.from({length:8},(_,i)=>row(String(i)));
  first.put(records,'1y');
  const q={...f.query,limit:2};
  const one=second.read(q);
  assert.equal(one.records.length,2); assert.ok(one.nextCursor);
  assert.throws(()=>first.read({...q,categories:['sleep'],cursor:one.nextCursor!}));
  const found=one.records.map(r=>r.observation.id);
  let next=one.nextCursor;
  while(next) {
    const page=first.read({...q,cursor:next});
    found.push(...page.records.map(r=>r.observation.id)); next=page.nextCursor!;
  }
  assert.deepEqual([...found].sort(),records.map(r=>r.id).sort());
  f.time(start+10);
  const corrected={...records[0],retrieved_at:new Date(start+10).toISOString(),values:{heart_rate_avg:82}};
  second.put([corrected],'7d');
  assert.throws(()=>first.read({...q,cursor:one.nextCursor!}));
  assert.equal(first.read({...q,limit:10}).records.find(r=>r.observation.id===corrected.id)?.observation.values.heart_rate_avg,82);
});

test('storage pressure preserves admitted records and reports an omission after reopen', t=>{
  const f=fixture(t,{slots:1,pageBytes:2048,indexBytes:4096}),a=f.open(true);
  const first=row('retained'); a.put([first],'7d');
  const tooBig=row('too big'); tooBig.values=Object.fromEntries(Array.from({length:40},(_,i)=>['field'+i,'x'.repeat(100)]));
  const large=a.put([tooBig],'7d');
  assert.equal(large.capacity,1); f.close(a);
  const reopened=f.open();
  assert.equal(reopened.read(f.query).capacityOmitted,true);
  assert.equal(reopened.read({...f.query,categories:['activity']}).capacityOmitted,false);
  assert.equal(reopened.read({startMs:start-day,endMs:start}).capacityOmitted,false);
  assert.deepEqual(reopened.read(f.query).records.map(r=>r.observation.id),[first.id]);
  assert.equal(reopened.put([tooBig],'1y').capacity,1);
  assert.equal(reopened.put([row('another metric',start,start,'exercise')],'7d').stored,1);
});

test('the former 4,000-observation limit does not evict an admitted earlier week', t => {
  const f=fixture(t,{slots:64,pageBytes:65_536,indexBytes:400_000}), archive=f.open(true);
  const weeks=48, perWeek=90;
  let now=start;
  for(let week=0;week<weeks;week++) {
    const beginning=start+week*7*day;
    now=beginning+perWeek;
    f.time(now);
    const batch=Array.from({length:perWeek},(_,i)=>row('synthetic training '+(week*perWeek+i),beginning+i,now,'exercise'));
    const recorded=archive.put(batch,'1y');
    assert.equal(recorded.stored,perWeek);
    assert.equal(recorded.capacity,0);
  }
  const query={startMs:start-1,endMs:now,limit:80};
  const seen=new Set<string>();
  let cursor:string|undefined;
  do {
    const page=archive.read({...query,cursor});
    assert.equal(page.capacityOmitted,false);
    assert.ok(page.records.length<=80);
    for(const item of page.records) {
      assert.equal(seen.has(item.observation.id),false);
      seen.add(item.observation.id);
    }
    cursor=page.nextCursor??undefined;
  } while(cursor);
  assert.equal(seen.size,weeks*perWeek);
  assert.ok(seen.has(row('synthetic training 0').id));
});

test('a deleted generation never reopens with new generation material after restoring the old file', t => {
  const f=fixture(t);
  const original=f.open(true);
  original.put([row('retired generation')],'6m');
  f.close(original);
  const snapshot=readFileSync(f.path);
  unlinkSync(f.path);
  assert.throws(()=>f.open());
  const freshKey=randomBytes(32);
  const fresh=f.open(true,freshKey);
  assert.deepEqual(fresh.read(f.query).records,[]);
  f.close(fresh);
  writeFileSync(f.path,snapshot);
  assert.throws(()=>f.open(false,freshKey));
  assert.throws(()=>f.open(true,freshKey));
});

test('an earlier encrypted data slot cannot replace a corrected slot under the current catalog',t=>{
  const f=fixture(t), a=f.open(true), item=row('revision');
  a.put([item],'1m');
  const db=new DatabaseSync(f.path);
  try {
    const old=db.prepare('SELECT slot,body FROM pages WHERE slot>=0').all();
    f.time(start+1);
    a.put([{...item,retrieved_at:new Date(start+1).toISOString(),values:{heart_rate_avg:74}}],'1y');
    const present=db.prepare('SELECT slot,body FROM pages WHERE slot>=0').all();
    const changed=old.filter((before,i)=>!Buffer.from(before.body as Uint8Array).equals(present[i].body as Uint8Array));
    assert.equal(changed.length,1);
    db.prepare('UPDATE pages SET body=? WHERE slot=?').run(changed[0].body,changed[0].slot);
    assert.throws(()=>a.read(f.query));
  } finally { db.close(); }
});
