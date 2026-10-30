// Explicit public-fixture probe, never part of tests or normal location updates.
import {MobilityNetwork} from '../server/mobility/network.ts';
import {TerrainProvider} from '../server/mobility/terrain.ts';
import {TransitousProvider} from '../server/mobility/transitous.ts';
const examples = {
  berlin: [{latitude:52.5163,longitude:13.3777},{latitude:52.5219,longitude:13.4132}],
  'sf-hill': [{latitude:37.8021,longitude:-122.4187},{latitude:37.8024,longitude:-122.4058}],
  amazon: [{latitude:-3,longitude:-60.2},{latitude:-3.01,longitude:-60.19}],
};
const name=process.argv[2];
if (!Object.hasOwn(examples,name)) throw new Error(`Choose a public fixture: ${Object.keys(examples).join(', ')}`);
const [origin,destination]=examples[name], network=new MobilityNetwork(), terrain=new TerrainProvider(network);
const started=performance.now(), cpu=process.cpuUsage(), signal=AbortSignal.timeout(40_000);
const plan=await new TransitousProvider(network).plan(origin,destination,new Date().toISOString(),signal);
const routeMs=Math.round(performance.now()-started);
const path=plan.walking.candidates[0]?.legs[0]?.path;
const profile=path?.length>=2?await terrain.profile(path,signal):null;
const elevations=profile?undefined:await terrain.elevations([origin,destination],signal);
for(const group of [plan.walking,plan.transit])for(const candidate of group.candidates)for(const leg of candidate.legs)delete leg.path;
console.log(JSON.stringify({example:name,route_ms:routeMs,total_ms:Math.round(performance.now()-started),cpu_usage_us:process.cpuUsage(cpu),
  max_rss_kib:process.resourceUsage().maxRSS,plan,terrain:profile,endpoint_elevations_m:elevations},null,2));
