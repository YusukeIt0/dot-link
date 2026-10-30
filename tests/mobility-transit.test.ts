import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EnturProvider,normalizeEnturPattern} from '../server/mobility/entur.ts';
import {MobilityNetwork} from '../server/mobility/network.ts';
const origin={latitude:59.9111,longitude:10.7503},destination={latitude:59.9205,longitude:10.6836};
const departure='2026-10-30T12:00:00Z';
function pattern() {return {duration:600,startTime:departure,endTime:'2026-10-30T12:10:00Z',legs:[{
  mode:'rail',distance:1000,duration:600,aimedStartTime:departure,aimedEndTime:'2026-10-30T12:10:00Z',
  expectedStartTime:departure,expectedEndTime:'2026-10-30T12:10:00Z',realtime:true,
  fromPlace:{name:'A',...origin},toPlace:{name:'B',...destination},line:{publicCode:'R1',name:'Local train'},
}]};}
test('transit retains actual/scheduled times and unknown cancellation/realtime age',()=>{
  const result=normalizeEnturPattern(pattern(),'2026-10-30T11:55:00Z');
  assert.equal(result.waiting_seconds,300);assert.equal(result.elapsed_from_requested_departure_seconds,900);
  assert.equal(result.legs[0]!.realtime_reported,true);assert.equal(result.legs[0]!.realtime_observed_at,null);
  assert.equal(result.legs[0]!.cancelled,null);assert.equal(result.transfers,0);
  const bad=pattern();bad.legs[0]!.expectedEndTime='2026-10-30T11:59:00Z';
  assert.throws(()=>normalizeEnturPattern(bad,departure),/legs/);
  bad.legs[0]!.mode='teleport';assert.throws(()=>normalizeEnturPattern(bad,departure),/mode/);
  const walking=pattern();walking.legs[0]!.mode='foot';assert.throws(()=>normalizeEnturPattern(walking,departure),/transit/);
});
test('out of regional coverage sends nothing; supported request uses identified bounded POST',async()=>{
  let calls=0;
  const provider=new EnturProvider(new MobilityNetwork(async(url,options)=>{
    calls++;assert.equal(String(url),'https://api.entur.io/journey-planner/v3/graphql');assert.equal(options?.method,'POST');
    assert.equal(new Headers(options?.headers).get('ET-Client-Name'),'dotlink-mobility');
    const q=JSON.parse(String(options?.body)).query;assert.match(q,/numTripPatterns:3/);assert.match(q,/dateTime:/);
    return Response.json({data:{trip:{tripPatterns:[pattern()]}}});
  }));
  const signal=new AbortController().signal;
  const outside=await provider.plan({latitude:13,longitude:100},{latitude:14,longitude:100},departure,signal);
  assert.equal(outside.status,'outside_source_coverage');assert.equal(calls,0);
  const result=await provider.plan(origin,destination,departure,signal);
  assert.equal(result.status,'available');assert.equal(calls,1);
});
test('empty and malformed source data stay unknown; cancellation is not hidden',async()=>{
  for(const payload of [{data:{trip:{tripPatterns:[]}}},{errors:[{}],data:{trip:{tripPatterns:[pattern()]}}},{}]) {
    const p=new EnturProvider(new MobilityNetwork(async()=>Response.json(payload)));
    const result=await p.plan(origin,destination,departure,new AbortController().signal);
    assert.equal(result.status,'unavailable');assert.match(result.limitations[0]!,/not that transport/);
  }
  const controller=new AbortController();let calls=0;
  const p=new EnturProvider(new MobilityNetwork(async()=>{calls++;controller.abort();return Response.json({});}));
  await assert.rejects(p.plan(origin,destination,departure,controller.signal),{name:'AbortError'});assert.equal(calls,1);
});
test('provider throttling is shared across clients without automatic retry',async()=>{
  let calls=0;
  const url=new URL('https://api.entur.io/journey-planner/v3/graphql');
  const first=new MobilityNetwork(async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'7200'}});});
  const second=new MobilityNetwork(async()=>{calls++;return Response.json({});});
  await assert.rejects(first.bytes(url,new AbortController().signal,100,{query:'{}'}),/unavailable/);
  await assert.rejects(second.bytes(url,new AbortController().signal,100,{query:'{}'}),/cooling down/);
  assert.equal(calls,1);
});
