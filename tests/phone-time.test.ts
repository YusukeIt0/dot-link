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
 const {evidence}=phoneTimeEvidence(entries,['2026-11-14']);
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
 assert.equal(result.evidence.spans.length,96);assert.equal(result.evidence.omitted_spans,4);
 assert.equal(result.earliestMeasurement,base-5000);
 const empty=phoneTimeEvidence([] ,['2026-11-14']);assert.equal(empty.evidence.status,'empty');assert.deepEqual(empty.evidence.spans,[]);
});
