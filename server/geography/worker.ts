import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { GeographicCache } from './cache.ts';
import { acquireGeography, geographicRegion } from './overture.ts';
import { geographicEvidence, validGeometry } from './geometry.ts';
import type { GeographicDataset, GeographicFix } from './types.ts';
import type { GeographyState } from './loader.ts';

if(!parentPort)throw new Error('Geography worker needs a parent');
const port=parentPort;
const cache=new GeographicCache(workerData.directory);
const DAY=86_400_000;
let fix:GeographicFix|undefined;
let latestKey:string|undefined;
let current:{key:string;dataset:GeographicDataset;state:GeographyState;revision:string}|undefined;
let active:AbortController|undefined;
let stopped=false;
let retryAfter=0;
let revision=0;
let refreshNeeded=false;

// Normalized data stays private to this worker; no exact fix is written to disk.
function validatedDataset(raw:unknown):raw is GeographicDataset {
  if(!raw||typeof raw!=='object')return false;
  const d=raw as GeographicDataset;
  if(d.source!=='Overture Maps'||!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(d.release)||d.license_url!=='https://docs.overturemaps.org/attribution/'||typeof d.attribution!=='string'||d.attribution.length>1000||!Array.isArray(d.features)||d.features.length>20_000||!Array.isArray(d.limitations)||d.limitations.length>30||!d.limitations.every(l=>typeof l==='string'&&l.length<500))return false;
  let vertices=0;
  const count=(v:unknown):number=>Array.isArray(v)?typeof v[0]==='number'?1:v.reduce((n,item)=>n+count(item),0):0;
  return d.features.every(f=>{
    if(!f||typeof f!=='object'||typeof f.id!=='string'||f.id.length>120||typeof f.kind!=='string'||f.kind.length>100||!['area','line','landmark'].includes(f.category)||!validGeometry(f.geometry,30_000))return false;
    vertices+=count(f.geometry.coordinates);
    if(vertices>800_000)return false;
    if(f.name!==undefined&&(typeof f.name!=='string'||f.name.length>200))return false;
    if(f.names!==undefined&&(typeof f.names!=='object'||f.names===null||Object.entries(f.names).length>6||!Object.entries(f.names).every(([k,v])=>k.length<30&&typeof v==='string'&&v.length<=200)))return false;
    return true;
  });
}
function emit() {
  if(stopped||!fix||!latestKey)return;
  if(current?.key===latestKey) {
    try {port.postMessage({state:current.state,evidence:geographicEvidence(fix,current.dataset),revision:current.revision});}
    catch {port.postMessage({state:'unavailable',revision:`unsupported-${revision}`});}
  } else port.postMessage({state:Date.now()<retryAfter?'unavailable':'pending',revision:`waiting-${latestKey}`});
}
function publish(key:string,dataset:GeographicDataset,state:GeographyState) {
  if(stopped)return;
  const hash=createHash('sha256').update(JSON.stringify([dataset.release,dataset.features,dataset.limitations])).digest('hex').slice(0,16);
  current={key,dataset,state,revision:`${key}-${hash}`}; revision++;
  emit();
}
async function load() {
  if(stopped||active||!fix||!latestKey||Date.now()<retryAfter)return;
  const region=geographicRegion(fix);if(!region)return;
  const key=region.key;
  active=new AbortController();const controller=active;
  try {
    const cached=await cache.get(`normalized-${key}`);
    if(cached) {
      try {
        const dataset=JSON.parse(Buffer.from(cached.bytes).toString('utf8'));
        if(validatedDataset(dataset)) {
          const stale=Math.floor(Date.now()/DAY)-cached.createdDay>=7;
          publish(key,dataset,stale?'stale':'ready');
          if(!stale)return;
        }
      } catch { /* Corrupt cache is replaced by a fresh bounded acquisition. */ }
    }
    const result=await acquireGeography({region,cache,signal:controller.signal,progress:dataset=>publish(key,dataset,'pending')});
    if(stopped||controller.signal.aborted)return;
    publish(key,result.dataset,result.complete?'ready':'partial');
    refreshNeeded=!result.complete;
    retryAfter=result.complete?0:Date.now()+60_000;
    const encoded=Buffer.from(JSON.stringify(result.dataset));
    if(result.complete&&encoded.byteLength<=16*1024*1024)await cache.put(`normalized-${key}`,encoded,controller.signal);
  } catch {
    if(stopped)return;
    refreshNeeded=true;retryAfter=Date.now()+60_000;
    if(current?.key===key)current={...current,state:current.state==='stale'?'stale':'partial'};
    emit();
  } finally {
    active=undefined;
    if(!stopped&&latestKey!==key) {retryAfter=0;void load();}
  }
}
port.on('message',(message:{type:string;fix?:GeographicFix})=>{
  if(message.type==='stop') {stopped=true;fix=undefined;current=undefined;active?.abort();port.close();return;}
  if(message.type!=='fix'||!message.fix)return;
  fix=message.fix;const region=geographicRegion(fix);
  if(!region) {latestKey=undefined;port.postMessage({state:'unavailable',revision:'unsupported'});return;}
  const changed=latestKey!==region.key;latestKey=region.key;
  if(changed) {retryAfter=0;refreshNeeded=false;}
  emit();
  if(current?.key!==latestKey||current.state==='stale'||current.state==='unavailable'||refreshNeeded)void load();
});
