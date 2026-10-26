import { Worker } from 'node:worker_threads';
import { GeographicCache } from './cache.ts';
import type { GeographicEvidence, GeographicFix } from './types.ts';

export type GeographyState = 'pending' | 'ready' | 'partial' | 'stale' | 'unavailable';
export interface GeographyUpdate { fix?: GeographicFix; state: GeographyState; evidence?: GeographicEvidence; revision: string }
export interface GeographyLoader {
  update(fix: GeographicFix): void;
  stop(): void;
  close(): void;
}

/** The location owner supplies only currently usable fixes and calls stop on revocation. */
export class LocalGeography implements GeographyLoader {
  private worker?: Worker;
  private terminating?: Promise<void>;
  private queuedFix?: GeographicFix;
  private latestFix?: GeographicFix;
  private closed=false;
  private generation = 0;
  private retryAfter = 0;
  private readonly maintenance: ReturnType<typeof setInterval>;
  private readonly directory: string;
  private readonly onUpdate: (result: GeographyUpdate) => void;
  constructor(directory: string, onUpdate: (result: GeographyUpdate) => void) {
    this.directory=directory; this.onUpdate=onUpdate;
    const cache=new GeographicCache(directory);
    const maintain=()=>{void cache.maintain().catch(()=>{});};
    maintain();this.maintenance=setInterval(maintain,6*60*60*1000);this.maintenance.unref();
  }
  update(fix: GeographicFix) {
    if(this.closed)return;
    this.latestFix={...fix};
    if(this.terminating) {this.queuedFix=fix;return;}
    if(!this.worker) {
      if(Date.now()<this.retryAfter)return;
      const generation=++this.generation;
      const worker=new Worker(new URL('./worker.ts',import.meta.url), {workerData:{directory:this.directory},resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32}});
      this.worker=worker; worker.unref();
      worker.on('message',(message:GeographyUpdate)=>{
        if(this.worker!==worker||generation!==this.generation)return;
        const fix=this.latestFix;
        if(!fix||!message.fix||message.fix.latitude!==fix.latitude||message.fix.longitude!==fix.longitude||message.fix.accuracy!==fix.accuracy)return;
        this.onUpdate(message);
      });
      const failed=()=>{
        if(this.worker!==worker||generation!==this.generation)return;
        this.worker=undefined;this.retryAfter=Date.now()+60_000;
        this.onUpdate({state:'unavailable',revision:`failed-${generation}`});
      };
      worker.on('error',failed); worker.on('exit',failed);
    }
    this.worker.postMessage({type:'fix',fix});
  }
  stop() {
    this.queuedFix=undefined;this.latestFix=undefined;
    const worker=this.worker; this.worker=undefined; this.generation++; this.retryAfter=0;
    // Abort first so pending writes clean up, then bound shutdown even if parsing is busy.
    if(worker) {
      worker.postMessage({type:'stop'});
      this.terminating=new Promise<void>(resolve=>{
        const timeout=setTimeout(()=>{void worker.terminate().then(()=>resolve(),()=>resolve());},250);timeout.unref();
        worker.once('exit',()=>{clearTimeout(timeout);resolve();});
      });
      void this.terminating.then(()=>{
        this.terminating=undefined;
        const fix=this.queuedFix;this.queuedFix=undefined;
        if(fix&&!this.closed)this.update(fix);
      });
    }
  }
  close() { this.closed=true;clearInterval(this.maintenance);this.stop(); }
}
