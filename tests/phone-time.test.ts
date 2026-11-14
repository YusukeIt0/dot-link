import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneTimeEvidence} from '../server/history/phone-time.ts';
import type {HistoryEntry} from '../server/history/replay.ts';
const base=Date.parse('2026-11-14T00:00:00Z');
function row(minutes:number, timezone:string|undefined='Asia/Tokyo', offset:number|undefined=540, epoch=1):HistoryEntry {
 return {id:String(minutes),source:'phone_location',latitude:10,longitude:10,accuracy:8,
  measured_at:new Date(base+minutes*60_000-5000).toISOString(),received_at:new Date(base+minutes*60_000).toISOString(),
  timezone,utc_offset_minutes:offset,recording_epoch:epoch};
}
test('dated phone spans retain alternative offsets, upload times, gaps and recording boundaries',()=>{
 const entries=[row(0),row(1),row(10),row(11,'Asia/Bangkok',420),row(12,'Asia/Bangkok',420,2),
  {...row(13),timezone:undefined,utc_offset_minutes:undefined},row(3000)];
 const result=phoneTimeEvidence(entries,['2026-11-14']);
 const evidence=result.evidence.by_source_date[0];
 assert.equal(evidence.observation_count,6);assert.equal(evidence.spans.length,5);
 assert.equal(evidence.spans[0].observation_count,2);
 assert.equal(evidence.spans[0].first.received_at,'2026-11-14T00:00:00.000Z');
 assert.equal(evidence.spans[0].first.location_measured_at,'2026-11-13T23:59:55.000Z');
 assert.equal(evidence.spans[1].preceding_gap_seconds,540);
 assert.equal(evidence.spans[2].utc_offset_minutes,420);assert.equal(evidence.spans[3].recording_boundary,true);
 assert.equal(evidence.spans[4].timezone,null);assert.equal(evidence.spans[4].utc_offset_minutes,null);
});
test('phone evidence is bounded with explicit omissions and never fills absent history',()=>{
 const result=phoneTimeEvidence(Array.from({length:100},(_,i)=>row(i*3)),['2026-11-14']);
 assert.equal(result.evidence.by_source_date[0].spans.length,96);assert.equal(result.evidence.by_source_date[0].omitted_spans,4);
 assert.equal(result.earliestMeasurement,base-5000);
 const empty=phoneTimeEvidence([] ,['2026-11-14']);assert.equal(empty.evidence.status,'empty');assert.deepEqual(empty.evidence.by_source_date[0].spans,[]);
});

 test('sparse multi-day reads retain each date and a brief alternate clock within the bound',()=>{
 const entries=Array.from({length:7*480},(_,i)=>row(i*3));
 entries[1700]={...entries[1700],timezone:'Asia/Bangkok',utc_offset_minutes:420};
 const dates=Array.from({length:7},(_,i)=>`2026-11-${14+i}`);
 const result=phoneTimeEvidence(entries,dates).evidence;
 assert.equal(result.by_source_date.length,7);
 assert.ok(result.by_source_date.reduce((n,d)=>n+d.spans.length,0)<=96);
 for(const day of result.by_source_date){
  assert.ok(day.spans.length>0);assert.ok(day.omitted_spans>0);
  assert.equal(day.omitted_clock_candidates,0);
  assert.ok(Date.parse(day.spans[0].first.received_at)<Date.parse(day.spans.at(-1)!.last.received_at));
 }
 assert.ok(result.by_source_date[0].spans.some(s=>s.first.received_at.startsWith('2026-11-14')));
 assert.ok(result.by_source_date.some(d=>d.spans.some(s=>s.utc_offset_minutes===420)));
});
