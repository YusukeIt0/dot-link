import { createHash } from 'node:crypto';
import type { GeographicCache } from './cache.ts';
import { acquireGeography, geographicRegion, type GeographicRegion } from './overture.ts';
import { geographicEvidence } from './geometry.ts';
import { validatedDataset } from './dataset.ts';
import type { GeographicDataset, GeographicFix } from './types.ts';
import type { GeographyState, GeographyUpdate } from './loader.ts';

const DAY=86_400_000;
type Current={createdDay:number;key:string;dataset:GeographicDataset;state:GeographyState;revision:string};

/** Resolves requested areas only. Consent, freshness and notifications belong to the caller. */
export class GeographicResolver {
  private fix?:GeographicFix;
  private latestKey?:string;
  private region?:GeographicRegion;
  private current?:Current;
  private active?:AbortController;
  private stopped=false;
  private retryAfter=0;
  private failures=0;
  private lastUseDay=-1;
  private refreshNeeded=false;
  private readonly cache:GeographicCache;
  private readonly acquire:typeof acquireGeography;
  private readonly now:()=>number;
  private readonly output:(result:GeographyUpdate)=>void;
  constructor(options:{cache:GeographicCache;output:(result:GeographyUpdate)=>void;acquire?:typeof acquireGeography;now?:()=>number}) {
    this.cache=options.cache;this.output=options.output;this.acquire=options.acquire??acquireGeography;this.now=options.now??Date.now;
  }
  update(fix:GeographicFix) {
    if(this.stopped)return;
    this.fix=fix;
    let region=geographicRegion(fix);
    if(region&&this.region) {
      const core=this.region.core,lat=(core.ymin+core.ymax)/2,lon=(core.xmin+core.xmax)/2;
      const delta=((fix.longitude-lon+540)%360)-180;
      if(Math.abs(fix.latitude-lat)<=.012&&Math.abs(delta)<=.01+.002/Math.cos(lat*Math.PI/180))region=this.region;
    }
    if(!region) {this.latestKey=undefined;this.region=undefined;this.active?.abort();this.output({fix:this.fix,state:'unavailable',revision:'unsupported'});return;}
    const changed=this.latestKey!==region.key;this.latestKey=region.key;this.region=region;
    if(changed) {this.retryAfter=0;this.failures=0;this.refreshNeeded=false;this.active?.abort();}
    const day=Math.floor(this.now()/DAY);
    if(this.current?.key===region.key) {
      if(this.current.state==='ready'&&day-this.current.createdDay>=7) {this.current={...this.current,state:'stale'};this.refreshNeeded=true;}
      if(day!==this.lastUseDay) {this.lastUseDay=day;void this.cache.get(`normalized-${region.key}`).catch(()=>{});}
    }
    this.emit();
    // Returning to a cached place must not wait behind another area's download.
    if(changed&&this.active)void this.reuse(region.key);
    if(this.current?.key!==this.latestKey||this.current.state==='stale'||this.current.state==='partial'||this.refreshNeeded)void this.load();
  }
  stop() {this.stopped=true;this.fix=undefined;this.latestKey=undefined;this.region=undefined;this.current=undefined;this.active?.abort();}
  private emit() {
    if(this.stopped||!this.fix||!this.latestKey)return;
    if(this.current?.key===this.latestKey) {
      try {this.output({fix:{...this.fix},state:this.current.state,evidence:geographicEvidence(this.fix,this.current.dataset),revision:this.current.revision});}
      catch {this.output({fix:this.fix,state:'unavailable',revision:'unsupported'});}
    } else this.output({fix:{...this.fix},state:this.now()<this.retryAfter?'unavailable':'pending',revision:`waiting-${this.latestKey}`});
  }
  private publish(key:string,dataset:GeographicDataset,state:GeographyState,createdDay=Math.floor(this.now()/DAY)) {
    if(this.stopped||key!==this.latestKey)return;
    const hash=createHash('sha256').update(JSON.stringify([dataset.release,dataset.features,dataset.limitations])).digest('hex').slice(0,16);
    this.current={createdDay,key,dataset,state,revision:`${key}-${hash}`};this.emit();
  }
  private async reuse(key:string):Promise<boolean> {
    try {
      const cached=await this.cache.get(`normalized-${key}`);
      if(!cached||this.stopped||key!==this.latestKey)return false;
      const dataset=JSON.parse(Buffer.from(cached.bytes).toString('utf8'));
      if(!validatedDataset(dataset))return false;
      const stale=Math.floor(this.now()/DAY)-cached.createdDay>=7;
      this.publish(key,dataset,stale?'stale':'ready',cached.createdDay);
      return !stale;
    }catch{return false;}
  }
  private backoff() {
    this.refreshNeeded=true;this.failures++;
    this.retryAfter=this.now()+Math.min(3_600_000,60_000*2**Math.min(6,this.failures-1));
  }
  private async load() {
    if(this.stopped||this.active||!this.fix||!this.latestKey||this.now()<this.retryAfter)return;
    const region=this.region;if(!region)return;
    const key=region.key,controller=new AbortController();this.active=controller;
    try {
      if(await this.reuse(key))return;
      if(this.stopped||controller.signal.aborted)return;
      // Keep the last complete stale map while a replacement is incomplete.
      const fallback=this.current?.key===key?this.current:undefined;
      const result=await this.acquire({region,cache:this.cache,signal:controller.signal,now:this.now,progress:dataset=>{if(!fallback&&!controller.signal.aborted)this.publish(key,dataset,'pending');}});
      if(this.stopped||controller.signal.aborted)return;
      if(result.complete||!fallback)this.publish(key,result.dataset,result.complete?'ready':'partial');
      if(key===this.latestKey) {if(result.complete){this.refreshNeeded=false;this.retryAfter=0;this.failures=0;}else this.backoff();}
      const encoded=Buffer.from(JSON.stringify(result.dataset));
      if(result.complete&&encoded.byteLength<=16*1024*1024)await this.cache.put(`normalized-${key}`,encoded,controller.signal);
    }catch {
      if(this.stopped||controller.signal.aborted)return;
      if(key===this.latestKey) {
        this.backoff();
        if(this.current?.key===key)this.current={...this.current,state:this.current.state==='stale'?'stale':'partial'};
        this.emit();
      }
    }finally {
      this.active=undefined;
      if(!this.stopped&&(this.latestKey!==key||controller.signal.aborted)) {this.retryAfter=0;void this.load();}
    }
  }
}
