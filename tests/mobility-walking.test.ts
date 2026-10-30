import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWalkingRoutes} from '../server/mobility/osrm.ts';
import {MobilityNetwork} from '../server/mobility/network.ts';
const origin = {latitude: 52, longitude: 13}, destination = {latitude: 52.001, longitude: 13};
function fixture() { return {code:'Ok',waypoints:[{location:[13,52],distance:0},{location:[13,52.001],distance:0}],
  routes:[{distance:112,duration:100,geometry:{type:'LineString',coordinates:[[13,52],[13,52.001]]},
    legs:[{distance:112,duration:100,steps:[{name:'Street\nname',mode:'walking',distance:112,duration:100,
      maneuver:{type:'depart',location:[13,52]}}]}]}]}; }
test('walking graph endpoints retain unknown connectors and honest mode/step limits',()=>{
  const input=fixture();
  const result=normalizeWalkingRoutes(input,origin,destination);
  assert.equal(result.status,'available');
  assert.equal(result.endpoints[0]?.connector_access,'unknown');
  assert.equal(result.candidates[0]?.steps[0]?.name,'Streetname');
  input.routes[0]!.legs[0]!.steps[0]!.mode='ferry';
  assert.equal(normalizeWalkingRoutes(input,origin,destination).candidates[0]?.contains_ferry,true);
});
test('reject distant snaps, disconnected geometry, other modes and inconsistent totals',()=>{
  const a=fixture();a.waypoints[0]!.location=[14,52];
  assert.throws(()=>normalizeWalkingRoutes(a,origin,destination));
  for(const mutate of [(x:ReturnType<typeof fixture>)=>{x.routes[0]!.geometry.coordinates[0]=[14,52];},
    (x:ReturnType<typeof fixture>)=>{x.routes[0]!.legs[0]!.steps[0]!.mode='driving';},
    (x:ReturnType<typeof fixture>)=>{x.routes[0]!.duration=1000;}]) {
    const input=fixture();mutate(input);
    assert.equal(normalizeWalkingRoutes(input,origin,destination).status,'unavailable');
  }
});
test('walking requests share one connection and rate allowance across network instances',async()=>{
  let calls=0,finish!:()=>void;
  const request:typeof fetch=async()=>{calls++;await new Promise<void>(r=>{finish=r;});return new Response('ok');};
  const a=new MobilityNetwork(request),b=new MobilityNetwork(request), signal=new AbortController().signal;
  const url=new URL('https://routing.openstreetmap.de/routed-foot/route/v1/foot/13,52;13,52.001');
  const first=a.bytes(url,signal,10);
  await assert.rejects(b.bytes(url,signal,10),/busy/);
  finish();await first;
  await assert.rejects(b.bytes(url,signal,10),/busy/);
  assert.equal(calls,1);
  const stopped=new AbortController();stopped.abort();
  await assert.rejects(a.bytes(url,stopped.signal,10),{name:'AbortError'});
  await assert.rejects(a.bytes(new URL('https://routing.openstreetmap.de/routed-car/route/v1/car/1,2;3,4'),signal,10),/endpoint/);
});
