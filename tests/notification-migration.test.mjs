import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validNotificationProof,legacyNotificationState,retireLegacyNotifications} from '../scripts/lib/notification-migration.mjs';
const now=1800000000000;
const proof=()=>({trusted:true,pid:123,updatedAt:now/1000,probes:[{registered:true,bodyMatched:true,selectedAtDetection:true,forwardingResult:'relay_accepted',forwarding:'Relay accepted',detectedAt:now/1000-2}]});
test('migration requires fresh successful notification detection and relay receipt',()=>{
 assert.equal(validNotificationProof(proof(),now),true);
 for(const p of [{...proof(),trusted:false},{...proof(),updatedAt:now/1000-121},{...proof(),updatedAt:now/1000+1},{...proof(),probes:[]},{...proof(),pid:0}])assert.equal(validNotificationProof(p,now),false);
 for(const field of ['registered','bodyMatched','selectedAtDetection']){const p=proof();p.probes[0][field]=false;assert.equal(validNotificationProof(p,now),false);}
 const p=proof();p.probes[0].forwardingResult='sending';assert.equal(validNotificationProof(p,now),false);
});
test('migration archives only the owned legacy login job and leaves relay jobs alone',async t=>{
 const home=await mkdtemp(join(tmpdir(),'dot-migration-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const directory=join(home,'project');const agent=join(home,'Library/LaunchAgents/local.even-g2-dot.menu.plist');
 await mkdir(join(home,'Library/LaunchAgents'),{recursive:true});await writeFile(agent,'legacy fixture');
 await mkdir(join(directory,'.runtime/notification-menu-unified'),{recursive:true});
 const legacy=join(directory,'.runtime/notification-menu/Dot Notification Lab.app/Contents/MacOS/DotNotificationLab');
 const p={Label:'local.even-g2-dot.menu',WorkingDirectory:directory,ProgramArguments:[legacy]};
 const calls=[];let terminated=false;const execute=async(cmd,args)=>{calls.push([cmd,args]);if(cmd.endsWith('/kill')){terminated=true;return '';}if(cmd.endsWith('plutil'))return JSON.stringify(p);if(cmd.endsWith('/ps'))return args.includes('-p')?join(home,'Applications/Dot Link.app/Contents/MacOS/DotLink'):terminated?'':'234 '+legacy;return '';};
 assert.equal((await legacyNotificationState(directory,{home,execute})).registered,true);
 await writeFile(join(directory,'.runtime/notification-menu-unified/diagnostics.json'),JSON.stringify({...proof(),trusted:false}));
 await assert.rejects(retireLegacyNotifications(directory,{home,execute,now}),/NOTIFICATION_TEST_REQUIRED/);
 assert.equal(await readFile(agent,'utf8'),'legacy fixture');assert.equal(calls.some(([c])=>c.endsWith('/kill')),false);
 await writeFile(join(directory,'.runtime/notification-menu-unified/diagnostics.json'),JSON.stringify(proof()));
 await retireLegacyNotifications(directory,{home,execute,now});
 assert.equal(await readFile(join(directory,'.runtime/notification-migration-backup/local.even-g2-dot.menu.'+now+'.plist'),'utf8'),'legacy fixture');
 assert(calls.some(([c,a])=>c.endsWith('/kill')&&a.join(' ')==='-TERM 234'));
 assert(!calls.some(([c,a])=>c.endsWith('launchctl')&&a.some(v=>/\.bridge|\.device|\.tunnel/.test(v))));
});

test('migration ignores display language and wording',()=>{
 for(const display of ['中継受領済み','Relay accepted','Sent','送信中','',undefined]) {
  const p=proof();p.probes[0].forwarding=display;
  assert.equal(validNotificationProof(p,now),true);
 }
});
test('legacy, unknown, failed and expired probe receipts cannot retire the old app',()=>{
 for(const result of [undefined,null,'pending','sending','send_unconfirmed','missing_credentials','ledger_managed','relay_received','unknown']) {
  const p=proof();p.probes[0].forwardingResult=result;p.probes[0].forwarding='中継受領済み';
  assert.equal(validNotificationProof(p,now),false);
 }
 for(const detectedAt of [undefined,null,NaN,now/1000-120,now/1000+1]) {
  const p=proof();p.probes[0].detectedAt=detectedAt;
  assert.equal(validNotificationProof(p,now),false);
 }
 const p=proof();delete p.probes[0].forwardingResult;
 assert.equal(validNotificationProof(p,now),false); // text-only v1/v2 records require a new test
});
