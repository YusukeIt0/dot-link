import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

const DAY = 86_400_000;
const KEY = /^[a-f0-9]{64}\.bin$/;
const MAGIC = 'dot-link-map-cache-v1';
export const MAP_CACHE_BYTES = 256 * 1024 * 1024;
export const MAP_ENTRY_BYTES = 32 * 1024 * 1024;

/** One active owner per directory. Stores reusable source bytes, never fixes or session IDs. */
export class GeographicCache {
  private operations: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private entries = new Map<string,{bytes:number;day:number}>();
  private bytes = 0;
  private readonly directory: string;
  private readonly options: { now?: () => number; maximumBytes?: number; maximumEntryBytes?: number };
  constructor(directory: string, options: {now?: () => number; maximumBytes?: number; maximumEntryBytes?: number} = {}) {
    this.directory = directory; this.options = options;
  }
  private now() {return (this.options.now ?? Date.now)();}
  private day() {return Math.floor(this.now() / DAY);}
  private key(identity: string) {return createHash('sha256').update(identity).digest('hex') + '.bin';}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operations.then(run, run); this.operations = next.catch(() => {}); return next;
  }
  private remember(name:string,entry?:{bytes:number;day:number}) {
    this.bytes-=this.entries.get(name)?.bytes??0;
    if(entry) {this.entries.set(name,entry);this.bytes+=entry.bytes;} else this.entries.delete(name);
  }
  private async initialize() {
    if(this.initialized)return;
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const info=await lstat(this.directory);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid map cache directory');
    await chmod(this.directory,0o700);await this.prune();this.initialized=true;
  }
  private async evict(extraBytes=0,extraFiles=0,protectedName?:string) {
    const maximum=this.options.maximumBytes??MAP_CACHE_BYTES;
    if(this.bytes+extraBytes<=maximum&&this.entries.size+extraFiles<=2048)return;
    for(const [name,entry] of [...this.entries].sort(([a,x],[b,y])=>x.day-y.day||a.localeCompare(b))) {
      if(this.bytes+extraBytes<=maximum&&this.entries.size+extraFiles<=2048)break;
      if(name===protectedName)continue;
      await rm(join(this.directory,name),{force:true});this.remember(name);
    }
  }
  private async prune() {
    this.entries.clear();this.bytes=0;
    for(const name of await readdir(this.directory)) {
      const path=join(this.directory,name);
      if(/^\.pending-[a-f0-9-]{36}$/.test(name)) {
        // A temporary write keeps its real modification time until activation.
        try {const info=await lstat(path);if(info.isFile()&&!info.isSymbolicLink()&&this.now()-info.mtimeMs>3_600_000)await rm(path,{force:true});}catch{}
        continue;
      }
      if(!KEY.test(name))continue;
      try {
        const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
        const info=await handle.stat().finally(()=>handle.close());
        const day=Math.floor(info.mtimeMs/DAY);
        if(!info.isFile()||info.size>(this.options.maximumEntryBytes??MAP_ENTRY_BYTES)+256||this.day()-day>=30||day>this.day()) {await rm(path,{force:true});continue;}
        this.remember(name,{bytes:info.size,day});
      }catch{/* Never follow external symlinks. */}
    }
    await this.evict();
  }
  get(identity:string):Promise<{bytes:Uint8Array;createdDay:number}|undefined> {
    return this.serial(async()=>{
      await this.initialize();const name=this.key(identity),path=join(this.directory,name);let handle;
      try {
        handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();
        const day=Math.floor(info.mtimeMs/DAY);
        if(!info.isFile()||info.size>(this.options.maximumEntryBytes??MAP_ENTRY_BYTES)+256||this.day()-day>=30||day>this.day())return undefined;
        const data=await handle.readFile(),end=data.indexOf(10);if(end<0||end>200)return undefined;
        const header=JSON.parse(data.subarray(0,end).toString('utf8'));
        if(header.magic!==MAGIC||!Number.isInteger(header.createdDay)||header.createdDay>this.day()||header.createdDay<0)return undefined;
        const payload=data.subarray(end+1);
        if(header.sha256!==createHash('sha256').update(payload).digest('hex'))return undefined;
        if(day!==this.day())await handle.utimes(this.day()*DAY/1000,this.day()*DAY/1000);
        this.remember(name,{bytes:info.size,day:this.day()});
        return {bytes:payload,createdDay:header.createdDay};
      }catch{return undefined;}finally{await handle?.close();}
    });
  }
  put(identity:string,data:Uint8Array,signal?:AbortSignal):Promise<void> {
    return this.serial(async()=>{
      signal?.throwIfAborted();
      if(data.byteLength>(this.options.maximumEntryBytes??MAP_ENTRY_BYTES))throw new Error('Map cache entry limit');
      await this.initialize();const name=this.key(identity),path=join(this.directory,name);
      const content=Buffer.concat([Buffer.from(JSON.stringify({magic:MAGIC,createdDay:this.day(),sha256:createHash('sha256').update(data).digest('hex')})+'\n'),data]);
      if(content.byteLength>(this.options.maximumBytes??MAP_CACHE_BYTES))throw new Error('Map cache capacity');
      await this.evict(content.byteLength-(this.entries.get(name)?.bytes??0),this.entries.has(name)?0:1,name);
      const temporary=join(this.directory,`.pending-${randomUUID()}`);let handle;
      try {
        handle=await open(temporary,'wx',0o600);await handle.writeFile(content);signal?.throwIfAborted();
        await rename(temporary,path);
        await handle.utimes(this.day()*DAY/1000,this.day()*DAY/1000);
        this.remember(name,{bytes:content.byteLength,day:this.day()});
      }finally{await handle?.close();await rm(temporary,{force:true});}
    });
  }
  maintain():Promise<void> {return this.serial(async()=>{if(!this.initialized)await this.initialize();else await this.prune();});}
}
