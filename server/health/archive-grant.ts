import { createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { lockHealthControl } from './control-lock.ts';
import { z } from 'zod';
import { HealthVault } from './vault.ts';
import { PolarHistoryArchive } from './archive.ts';
import type { PolarConnection } from './polar.ts';
import type { HistoryPeriod } from '../history/retention.ts';

type HealthIdentity = {owner?:string; connection?:PolarConnection; deletedBefore:number; enabled:boolean};
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const schema=z.object({version:z.literal(1), epoch:z.uuid(), subject:hex, credential:hex,
  snapshots:z.array(hex).min(1).max(2), deletedBefore:z.number().int().nonnegative(), enabled:z.boolean(),
  generation:z.object({id:z.uuid(),key:z.string().regex(/^[A-Za-z0-9+/]{43}=$/)}).strict().nullable()}).strict();
type Policy=z.infer<typeof schema>;
const denied=()=>new Error('POLAR_HISTORY_UNAVAILABLE');
export type PolarArchiveChoice={action:'set';enabled:boolean}|{action:'delete'};
export type PolarArchiveLease={epoch:string; period:HistoryPeriod; deletedBefore:number};

/** The original seven-day vault stays readable by old applications. This
 * independently wrapped generation is valid only along acknowledged v1 writes. */
export class PolarArchiveGrant {
  private readonly health:HealthVault;
  private readonly policyFile:HealthVault;
  private readonly directory:string;
  private readonly now:()=>number;
  private key?:Buffer;
  private policy?:Policy;
  private epoch:string=randomUUID();
  private fault=false;
  constructor(health:HealthVault, now:()=>number) {
    this.health=health;
    this.directory=health.path+'.history';
    this.policyFile=new HealthVault(join(this.directory,'grant.enc'));
    this.now=now;
  }
  private locked<T>(run:()=>T,create=false) {
    const release=lockHealthControl(this.directory,create);
    try{return run();}finally{release?.();}
  }
  private sync() {
    if (!this.policyFile.exists()) {
      if (this.policy){this.policy=undefined;this.epoch=randomUUID();}
      return;
    }
    if (!this.key)throw denied();
    if (!this.policy || !this.policyFile.fingerprint || !this.policyFile.matches(this.policyFile.fingerprint)) {
      this.policy=schema.parse(this.policyFile.read(this.key));
    }
  }
  private currentSnapshot(){
    return !!this.health.fingerprint && this.health.matches(this.health.fingerprint);
  }
  liveSnapshotCurrent(){
    try{return !lstatSync(this.directory,{throwIfNoEntry:false})||this.currentSnapshot();}
    catch{return false;}
  }
  private boundSnapshot(){
    return !!this.health.fingerprint && !!this.policy?.snapshots.includes(this.health.fingerprint) && this.currentSnapshot();
  }
  private identities(s:HealthIdentity) {
    const c=s.connection;
    if (!s.owner||!c?.userId||!c.clientId||!c.accessToken||!this.key) return;
    const hash=(data:unknown[])=>createHmac('sha256',this.key!).update(JSON.stringify(data)).digest('hex');
    return {subject:hash(['member',s.owner,c.clientId,c.userId]),credential:hash(['authorization',c.accessToken,s.deletedBefore])};
  }
  private save(p:Policy) {
    if (!this.key) throw denied();
    this.policyFile.write(this.key,p);
    this.policy=p;
  }
  restore(healthKey:Buffer, s:HealthIdentity, snapshot:string) {
    this.close();
    this.key=Buffer.from(hkdfSync('sha256',healthKey,Buffer.alloc(0),'dot-link:polar:archive-grant:v1',32));
    this.fault=false;
    try {this.locked(()=>{
      if(!this.currentSnapshot())throw denied();
      this.sync();
      const p=this.policy;
      if (p) {
        const identity=this.identities(s);
        if (!identity || p.subject!==identity.subject) this.remove();
        else if (p.credential!==identity.credential || !p.snapshots.includes(snapshot)) {
          // Retire the previous generation even if an older client returned
          // to the very same token and sharing state between application runs.
          this.save({...p,...identity,epoch:randomUUID(),snapshots:[snapshot],deletedBefore:Math.max(this.now(),p.deletedBefore),enabled:false,generation:null});
        } else if (!s.enabled && p.enabled) this.save({...p,enabled:false,epoch:randomUUID()});
      }
      this.collect();
    });} catch {this.fault=true;}
  }
  private collect() {
    const info=lstatSync(this.directory,{throwIfNoEntry:false});
    if (!info) return;
    if (!info.isDirectory()) throw denied();
    const current=this.policy?.generation?.id;
    for (const name of readdirSync(this.directory)) {
      const match=/^([a-f0-9-]{36})\.sqlite(?:-(?:wal|shm|journal))?$/.exec(name);
      if (match && match[1]!==current) unlinkSync(join(this.directory,name));
    }
  }
  reset() {
    this.locked(()=>this.remove());
  }
  private remove() {
    if (this.policyFile.exists()) this.policyFile.remove();
    this.policy=undefined;
    this.epoch=randomUUID();
    this.fault=false;
    this.collect();
  }
  /** Record both sides before atomic rename. A crash can leave either legitimate
   * snapshot, while an older client produces a fresh unsupported nonce. */
  checkpoint(next:HealthIdentity, old:string|undefined, pending:string) {
    if (!old) return;
    let release:(()=>void)|undefined;
    try{release=lockHealthControl(this.directory);}
    catch{this.fault=true;return;}
    if (!release) return;
    try {
      if(!this.health.matches(old))throw denied();
      try{this.sync();}catch{this.fault=true;return release;}
      const p=this.policy;
      if(!p||this.fault)return release;
      const identity=this.identities(next);
      if (!identity||identity.subject!==p.subject) {this.remove();return release;}
      const changed=!p.snapshots.includes(old)||identity.credential!==p.credential;
      try{this.save({...p,...identity,snapshots:[old,pending],
        ...(changed?{generation:null,enabled:false,epoch:randomUUID(),deletedBefore:Math.max(this.now(),p.deletedBefore)}:
          !next.enabled && p.enabled?{enabled:false,epoch:randomUUID()}: {})});
        if (changed) this.collect();
      }catch{this.fault=true;}
      return release;
    } catch(error) {release();throw error;}
  }
  status(eligible:boolean) {
    let ready=eligible&&!!this.key&&!this.fault;
    if(ready){try{this.locked(()=>{this.sync();if(this.policy&&!this.boundSnapshot())throw denied();});}catch{ready=false;}}
    return {epoch:this.policy?.epoch??this.epoch,enabled:ready&&!!this.policy?.enabled,available:ready};
  }
  control(s:HealthIdentity,snapshot:string,epoch:string,change:PolarArchiveChoice,authorize?:()=>boolean) {
    this.locked(()=>{
      if(authorize&&!authorize())throw denied();
      this.change(s,snapshot,epoch,change);
    },true);
  }
  private change(s:HealthIdentity,snapshot:string,epoch:string,change:PolarArchiveChoice) {
    this.sync();
    const identity=this.identities(s);
    if (!identity||!this.key||this.fault||(this.policy?.epoch??this.epoch)!==epoch||!this.currentSnapshot()) throw denied();
    const prior=this.policy;
    if (prior && (prior.subject!==identity.subject || prior.credential!==identity.credential || !prior.snapshots.includes(snapshot))) throw denied();
    if (change.action==='set' && (prior?.enabled??false)===change.enabled) return;
    let generation=prior?.generation??null;
    if (change.action==='set' && change.enabled && !generation) {
      const key=randomBytes(32),id=randomUUID();
      try {
        new PolarHistoryArchive(join(this.directory,id+'.sqlite'),key,{create:true,now:this.now}).close();
        generation={id,key:key.toString('base64')};
      } finally {key.fill(0);}
    }
    this.save({version:1,...identity,epoch:randomUUID(),enabled:change.action==='set'&&change.enabled,generation:change.action==='delete'?null:generation,
      deletedBefore:change.action==='delete'?Math.max(this.now(),prior?.deletedBefore??0):prior?.deletedBefore??0,snapshots:[snapshot]});
    this.collect();
  }
  capture(s:HealthIdentity,period:HistoryPeriod|undefined):PolarArchiveLease|undefined {
    if(!period||this.fault||!this.key)return;
    return this.locked(()=>{
      this.sync();
      const p=this.policy;
      if (!p?.enabled || !p.generation || !this.boundSnapshot()) return;
      const identity=this.identities(s);
      if (identity?.subject!==p.subject || identity.credential!==p.credential) return;
      return {epoch:p.epoch,period,deletedBefore:Math.max(p.deletedBefore,s.deletedBefore)};
    });
  }
  use<T>(lease:PolarArchiveLease,run:(store:PolarHistoryArchive)=>T):T {
    return this.locked(()=>{
      this.sync();
      if (this.policy?.epoch!==lease.epoch || !this.policy?.enabled || this.fault || !this.boundSnapshot()) throw denied();
      return this.withStore(run);
    });
  }
  private withStore<T>(run:(store:PolarHistoryArchive)=>T) {
    const generation=this.policy?.generation;
    if (!generation) throw denied();
    const key=Buffer.from(generation.key,'base64');
    try {
      const db=new PolarHistoryArchive(join(this.directory,generation.id+'.sqlite'),key,{now:this.now});
      try{return run(db);}finally{db.close();}
    } finally {key.fill(0);}
  }
  maintain() {this.locked(()=>{this.sync();if (this.policy?.generation&&!this.fault&&this.currentSnapshot()) this.withStore(db=>db.prune());});}
  close(){this.key?.fill(0);this.key=undefined;this.policy=undefined;this.epoch=randomUUID();}
}
