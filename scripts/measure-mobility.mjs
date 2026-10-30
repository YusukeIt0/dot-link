// Explicit public-fixture probe, never part of tests or normal location updates.
import {MobilityNetwork} from '../server/mobility/network.ts';
import {TerrainProvider} from '../server/mobility/terrain.ts';
import {WalkingProvider} from '../server/mobility/osrm.ts';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const fixtures=JSON.parse(readFileSync(new URL('./fixtures/mobility-regions.json',import.meta.url),'utf8'));
const examples=Object.fromEntries(fixtures.map(f=>[f.id,f.points.map(([latitude,longitude])=>({latitude,longitude}))]));
export async function measureMobility(name) {
if (!Object.hasOwn(examples,name)) throw new Error(`Choose a public fixture: ${Object.keys(examples).join(', ')}`);
const [origin,destination]=examples[name], network=new MobilityNetwork(), terrain=new TerrainProvider(network);
const started=performance.now(), cpu=process.cpuUsage(), signal=AbortSignal.timeout(40_000);
const walking=await new WalkingProvider(network).plan(origin,destination,signal);
const routeMs=Math.round(performance.now()-started),path=walking.candidates[0]?.path;
const profile=path?.length>=2?await terrain.profile(path,signal):null;
const elevations=profile?undefined:await terrain.elevations([origin,destination],signal);
for(const candidate of walking.candidates)delete candidate.path;
return {example:name,route_ms:routeMs,total_ms:Math.round(performance.now()-started),cpu_usage_us:process.cpuUsage(cpu),
  max_rss_kib:process.resourceUsage().maxRSS,network:network.stats(),walking,terrain:profile,endpoint_elevations_m:elevations};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await measureMobility(process.argv[2]),null,2));
