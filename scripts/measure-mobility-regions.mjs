// Explicit, sequential public-fixture survey. Never called by the app or CI.
import {setTimeout as wait} from 'node:timers/promises';
import {fixtures,measureMobility} from './measure-mobility.mjs';
if(process.argv[2]!=='--run')throw new Error('Use --run [first-fixture-id] to make the bounded public-fixture network survey explicit.');
const start=process.argv[3]?fixtures.findIndex(f=>f.id===process.argv[3]):0;
if(start<0)throw new Error('Unknown public fixture');
for(const f of fixtures.slice(start)){
  const base={id:f.id,region:f.region,area:f.area,kind:f.kind};
  try {
    const d=await measureMobility(f.id);
    console.log(JSON.stringify({...base,route_ms:d.route_ms,total_ms:d.total_ms,network:d.network,max_rss_kib:d.max_rss_kib,
      walking_status:d.walking.status,walking_candidates:d.walking.candidates.length,
      first_walk_m:d.walking.candidates[0]?.distance_m??null,snap_distances_m:d.walking.endpoints.map(p=>p.distance_from_requested_point_m),
      terrain_status:d.terrain?.status??'endpoints_only',terrain_confidence:d.terrain?.confidence??null,
      endpoint_elevations_m:d.endpoint_elevations_m??[d.terrain?.origin_elevation_m??null,d.terrain?.destination_elevation_m??null],
      terrain_totals_withheld:d.terrain?.ascent_m==null}));
  }catch{console.log(JSON.stringify({...base,status:'probe_unavailable'}));}
  // Keep process-wide provider cooldowns and rate state across all fixtures.
  await wait(1500);
}
