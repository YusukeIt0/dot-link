import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VbbProvider,normalizeVbbJourney} from '../server/mobility/vbb.ts';
import {RegionalTransitProvider} from '../server/mobility/transit.ts';
import {MobilityNetwork} from '../server/mobility/network.ts';
const from={latitude:52.5163,longitude:13.3777},to={latitude:52.5219,longitude:13.4132},departure='2026-10-30T12:00:00Z';
function journey(){return {legs:[{origin:{...from,address:'Origin'},destination:{name:'Station',location:to},
  departure,arrival:'2026-10-30T12:10:00Z',plannedDeparture:departure,plannedArrival:'2026-10-30T12:10:00Z',
  tripId:'public-trip',line:{name:'U5',mode:'train',product:'subway'},departurePrognosisType:'prognosed'}]};}
test('VBB preserves missing vehicle distance, forecast uncertainty and cancelled rides',()=>{
  const row=journey(),result=normalizeVbbJourney(row,departure);
  assert.equal(result.legs[0]!.mode,'SUBWAY');assert.equal(result.legs[0]!.distance_m,null);
  assert.equal(result.legs[0]!.realtime_reported,true);assert.equal(result.legs[0]!.realtime_observed_at,null);
  assert.equal(result.legs[0]!.cancelled,null);assert.equal(result.transfers,0);
  const cancelled={...row,legs:[{...row.legs[0],departure:null,arrival:null,cancelled:true}]};
  assert.equal(normalizeVbbJourney(cancelled,departure).legs[0]!.cancelled,true);
  assert.equal(normalizeVbbJourney(cancelled,departure).service_status,'cancelled');
  assert.equal(result.service_status,'no_disruption_reported');
});
test('VBB rejects disconnected or overlapping legs and unknown walking distance is not zero',()=>{
  const row=journey();
  const walk={origin:{...from,address:'Origin'},destination:{...from,address:'Access'},walking:true,distance:null,
    departure:'2026-10-30T11:59:00Z',arrival:departure,plannedDeparture:'2026-10-30T11:59:00Z',plannedArrival:departure};
  const withWalk={legs:[walk,...row.legs]};
  assert.equal(normalizeVbbJourney(withWalk,'2026-10-30T11:59:00Z').walking_distance_m,null);
  assert.throws(()=>normalizeVbbJourney({legs:[row.legs[0],{...row.legs[0],origin:{latitude:0,longitude:0}}]},departure),/Inconsistent/);
  assert.throws(()=>normalizeVbbJourney({legs:[{...row.legs[0],tripId:undefined}]},departure),/Unidentified/);
});
test('regional selection queries only the matching keyless source and checks returned endpoints',async()=>{
  const urls:string[]=[];
  const regional=new RegionalTransitProvider(new MobilityNetwork(async u=>{urls.push(String(u));return Response.json({journeys:[journey()]});}));
  const signal=new AbortController().signal;
  const berlin=await regional.plan(from,to,departure,signal);assert.equal(berlin.status,'available');assert.equal(berlin.candidates.length,1);
  assert.match(urls[0]!,/^https:\/\/v6.vbb.transport.rest\/journeys/);
  const tokyo=await regional.plan({latitude:35.68,longitude:139.76},{latitude:35.69,longitude:139.77},departure,signal);
  assert.equal(tokyo.status,'outside_source_coverage');assert.equal(urls.length,1);
  const wrong=new VbbProvider(new MobilityNetwork(async()=>Response.json({journeys:[journey()]})));
  const mismatch=await wrong.plan({latitude:52.53,longitude:13.3},to,departure,signal);assert.equal(mismatch.status,'unavailable');
});

test('VBB excludes cancelled and unreachable journeys from usable candidates',async()=>{
  const row=journey();
  const cancelled={legs:[{...row.legs[0],departure:null,arrival:null,cancelled:true}]};
  const unreachable={legs:[{...row.legs[0],reachable:false}]};
  assert.equal(normalizeVbbJourney(unreachable,departure).service_status,'unreachable');
  const plan=(journeys:unknown[])=>new VbbProvider(new MobilityNetwork(async()=>Response.json({journeys})))
    .plan(from,to,departure,new AbortController().signal);
  const allDisrupted=await plan([cancelled,unreachable]);
  assert.equal(allDisrupted.status,'unavailable');assert.equal(allDisrupted.candidates.length,0);
  assert.equal(allDisrupted.excluded_disrupted_candidates,2);
  const mixed=await plan([cancelled,row,unreachable]);
  assert.equal(mixed.status,'partial');assert.equal(mixed.candidates.length,1);
  assert.equal(mixed.candidates[0]!.service_status,'no_disruption_reported');
  assert.equal(mixed.excluded_disrupted_candidates,2);
});
