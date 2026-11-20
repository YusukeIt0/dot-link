import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PolarHistoryArchive } from '../server/health/archive.ts';
import { normalize } from '../server/health/data.ts';
import { historyExpiry } from '../server/history/retention.ts';

// Synthetic provider shapes only. No live Polar credentials or personal data.
const dayMs = 86_400_000;
const first = Date.parse('2025-01-01T12:00:00Z');
const clock = minute => new Date(minute * 60_000).toISOString().slice(11,19);
function observations(day, received) {
  const date = new Date(day).toISOString().slice(0,10);
  const start = date+'T09:00:00Z';
  const zones = Array.from({length:1440}, (_,minute)=>({timestamp:date+'T'+clock(minute)+'Z',zone:'SEDENTARY'}));
  const beats = Array.from({length:288}, (_,index)=>({sample_time:clock(index*5),heart_rate:55+index%40}));
  return [
    ...normalize('activity',[{start_time:start,steps:12345,samples:{activity_zones:{samples:zones}}}],received),
    ...normalize('sleep',{nights:[{sleep_start_time:date+'T00:30:00Z',sleep_end_time:date+'T07:30:00Z',sleep_score:82}]},received),
    ...normalize('recovery',{recharges:[{date,heart_rate_avg:65,ans_charge:2}]},received),
    ...normalize('exercise',[{start_time:start,sport:'WALKING',duration:'PT30M'}],received),
    ...normalize('heart_rate',[{date,heart_rate_samples:beats}],received),
  ];
}
const directory = mkdtempSync(join(tmpdir(),'dot-link-polar-bench-'));
const path = join(directory,'archive.sqlite');
const key = randomBytes(32);
const options = {now:()=>now};
let now = first;
let archive;
function milliseconds(values, percentile) {
  const sorted=[...values].sort((a,b)=>a-b);
  return Number(sorted[Math.ceil(sorted.length*percentile)-1].toFixed(2));
}
function summary(values) { return {p50:milliseconds(values,0.5),p95:milliseconds(values,0.95)}; }
try {
  let tick=performance.now();
  archive=new PolarHistoryArchive(path,key,{...options,create:true});
  const createMs=Number((performance.now()-tick).toFixed(2)), fileBytes=statSync(path).size;
  let writes=0, capacity=0, inputBytes=0;
  const deadlines=[];
  const batches=[];
  for(let index=0; index<365; index++) {
    const day=first+index*dayMs;
    now=day+10*3600_000;
    const records=observations(day,now);
    assert.equal(records.length,5);
    assert.equal(records[0].activity_zone_samples.length,1440);
    deadlines.push(...records.map(record=>historyExpiry(record.retention_anchor,'1y')));
    inputBytes+=Buffer.byteLength(JSON.stringify(records));
    tick=performance.now();
    const result=archive.put(records,'1y');
    batches.push(performance.now()-tick);
    writes+=result.stored;
    capacity+=result.capacity;
  }
  assert.equal(writes,1825); assert.equal(capacity,0); assert.equal(statSync(path).size,fileBytes);
  archive.close(); archive=undefined;
  tick=performance.now();
  archive=new PolarHistoryArchive(path,key,options);
  const reopenMs=Number((performance.now()-tick).toFixed(2));
  const weekQueries=[];
  for(let run=0; run<32; run++) {
    const end=first+Math.floor((run*137)%356+8)*dayMs;
    const q={startMs:end-7*dayMs,endMs:end,categories:['exercise'],limit:80};
    tick=performance.now();
    const page=archive.read(q);
    weekQueries.push(performance.now()-tick);
    assert.equal(page.records.length,7);
    assert.equal(page.nextCursor,null);
  }
  const monthsQuery={startMs:Date.parse('2024-12-31T12:00:00Z'),endMs:now,categories:['sleep','activity','recovery','exercise','heart_rate'],limit:80};
  let cursor, pages=0;
  const ids=new Set();
  tick=performance.now();
  do {
    const page=archive.read({...monthsQuery,cursor});
    assert.equal(page.capacityOmitted,false);
    for(const record of page.records) {
      assert.equal(ids.has(record.observation.id),false); ids.add(record.observation.id);
    }
    cursor=page.nextCursor;
    pages++;
  } while(cursor);
  const yearReadMs=Number((performance.now()-tick).toFixed(2));
  const expired=deadlines.filter(deadline=>deadline<=now).length;
  assert.equal(expired,2); // The first two date-only records use UTC+14 as their earliest anchor.
  assert.equal(ids.size,writes-expired);
  console.log(JSON.stringify({days:365,writes,expired,inputBytes,fixedFileBytes:fileBytes,capacityOmitted:capacity,
    createMs,dailyWriteMs:summary(batches),reopenMs,sevenDayExerciseQueryMs:summary(weekQueries),yearFullRead:{rows:ids.size,pages,ms:yearReadMs}},null,2));
} finally {
  archive?.close(); key.fill(0);
  rmSync(directory,{recursive:true,force:true});
}
