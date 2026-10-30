// Explicit, bounded network measurement using public examples only. Never part of npm test.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GeographicCache } from '../server/geography/cache.ts';
import { acquireGeography, geographicRegion } from '../server/geography/overture.ts';
import { geographicEvidence } from '../server/geography/geometry.ts';

const examples={
  bangkok:{longitude:100.5418,latitude:13.7308,accuracy:5},
  tokyo:{longitude:139.7101,latitude:35.6852,accuracy:5},
  fuji:{longitude:138.7274,latitude:35.3606,accuracy:5},
  yosemite:{longitude:-119.58,latitude:37.745,accuracy:5},
  berlin:{longitude:13.35,latitude:52.514,accuracy:5},
  nairobi:{longitude:36.825,latitude:-1.375,accuracy:5},
  amazon:{longitude:-60.2,latitude:-3,accuracy:5},
};
const name=process.argv[2];
if(!Object.hasOwn(examples,name))throw new Error(`Choose one public example: ${Object.keys(examples).join(', ')}`);
const directory=process.argv[3]?resolve(process.argv[3]):await mkdtemp(join(tmpdir(),'dot-geography-measure-'));
const fix=examples[name], start=performance.now(),cpuStart=process.cpuUsage();
let firstEvidenceMs, firstNamedEvidenceMs;
const progress=[];
const result=await acquireGeography({region:geographicRegion(fix),cache:new GeographicCache(directory),signal:new AbortController().signal,
 diagnostic:event=>console.error(JSON.stringify({example:name,elapsed_ms:Math.round(performance.now()-start),...event})),
 progress(dataset){
  const evidence=geographicEvidence(fix,dataset),elapsed=Math.round(performance.now()-start);
  const items=[...evidence.areas,...evidence.lines,...evidence.landmarks];
  if(firstEvidenceMs===undefined&&items.length)firstEvidenceMs=elapsed;
  if(firstNamedEvidenceMs===undefined&&items.some(x=>x.name))firstNamedEvidenceMs=elapsed;
  const event={example:name,elapsed_ms:elapsed,features:dataset.features.length,evidence_count:items.length,
   limitations:dataset.limitations,areas:evidence.areas.map(x=>({name:x.name,kind:x.kind,relation:x.relation})),
   lines:evidence.lines.map(x=>({name:x.name,kind:x.kind})),landmarks:evidence.landmarks.map(x=>({name:x.name,kind:x.kind}))};
  progress.push(event);console.error(JSON.stringify(event));
 },
});
console.log(JSON.stringify({example:name,elapsed_ms:Math.round(performance.now()-start),first_evidence_ms:firstEvidenceMs??null,
 first_named_evidence_ms:firstNamedEvidenceMs??null,cpu_usage_us:process.cpuUsage(cpuStart),max_rss_kib:process.resourceUsage().maxRSS,
 ...result.stats,complete:result.complete,features:result.dataset.features.length,
 dataset_sha256:createHash('sha256').update(JSON.stringify(result.dataset)).digest('hex'),progress,
 evidence:geographicEvidence(fix,result.dataset)},null,2));
