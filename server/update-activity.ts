import {writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
// Only timestamps and counters; never credentials, audio, or conversation content.
export class UpdateActivity {
 private active=0; private lastClient=Date.now();
 private timer:NodeJS.Timeout;
 private directory:string;
 constructor(directory:string){this.directory=directory;this.flush();this.timer=setInterval(()=>this.flush(),15000);this.timer.unref();}
 begin(){this.active++;this.lastClient=Date.now();this.flush();let done=false;return ()=>{if(done)return;done=true;this.active--;this.lastClient=Date.now();this.flush();};}
 maintenance(){return existsSync(join(this.directory,'app-update.json'));}
 close(){clearInterval(this.timer);}
 private flush(){const path=join(this.directory,'update-activity.json');try{writeFileSync(path+'.tmp',JSON.stringify({at:Date.now(),lastClient:this.lastClient,active:this.active}),{mode:0o600});renameSync(path+'.tmp',path);}catch{/* Readiness fails closed when this file is absent or stale. */}}
}
