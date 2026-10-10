import { cp, mkdir, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve('.'), output=resolve(process.argv[2] ?? '.runtime/mac-app/Dot Link.app'), contents=join(output,'Contents'), payload=join(contents,'Resources/payload');
if (!output.startsWith(join(root,'.runtime')+'/') || !output.endsWith('/Dot Link.app')) throw new Error('Build output must be a Dot Link.app below .runtime');
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit'});if(r.status!==0)throw new Error('Build step failed: '+cmd);};
run(process.execPath,['scripts/prepare-sparkle.mjs']);
try {
 const info=await readFile(join(contents,'Info.plist'),'utf8');
 if(!info.includes('app.tripsurf.dotlink.mac'))throw new Error('Refusing to replace an unknown app');
 await rm(output,{recursive:true});
}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(join(contents,'MacOS'),{recursive:true});await mkdir(payload,{recursive:true});
for(const name of ['package.json','package-lock.json','server','src','dist'])await cp(join(root,name),join(payload,name),{recursive:true});
await mkdir(join(payload,'scripts/lib'),{recursive:true});
for(const name of ['mac-setup.mjs','setup-status.mjs','manage.mjs','setup.mjs','prepare-tunnel.mjs','beta-pair.mjs','mac-runtime-manifest.json'])await cp(join(root,'scripts',name),join(payload,'scripts',name));
for(const name of ['setup.mjs','service-management.mjs','mac-install.mjs','menu-install.mjs','notification-migration.mjs','pairing-status.mjs','app-lifecycle.mjs','app-uninstall.mjs','app-update.mjs'])await cp(join(root,'scripts/lib',name),join(payload,'scripts/lib',name));
await mkdir(join(payload,'.runtime'),{recursive:true});
await cp(join(root,'.runtime/vendor/runtime/bin'),join(payload,'.runtime/bin'),{recursive:true});
await cp(join(root,'.runtime/vendor/runtime/licenses'),join(contents,'Resources/licenses'),{recursive:true});
await mkdir(join(payload,'docs'),{recursive:true});
const publicDocs=join(root,'docs');
for(const name of ['operations.md','dot-setup.md','privacy.md'])await cp(join(publicDocs,name),join(payload,'docs',name));
await cp(join(root,'LICENSE'),join(contents,'Resources/licenses/Dot-Link-LICENSE.txt'));
await cp(join(root,'distribution/licenses'),join(contents,'Resources/licenses/additional'),{recursive:true});
const copied=new Set();
async function copyDependency(name,from=root){
 let path=join(from,'node_modules',name);
 try{await lstat(join(path,'package.json'));}catch{path=join(root,'node_modules',name);}
 const relative=path.slice(root.length+1);if(copied.has(relative))return;copied.add(relative);
 const dest=join(payload,relative);await mkdir(dirname(dest),{recursive:true});await cp(path,dest,{recursive:true});
 const meta=JSON.parse(await readFile(join(path,'package.json'),'utf8'));
 for(const dep of Object.keys(meta.dependencies??{}))await copyDependency(dep,path);
}
const pkg=JSON.parse(await readFile('package.json','utf8'));
for(const name of [...Object.keys(pkg.dependencies),'qrcode'])await copyDependency(name);
// A bundle may contain runtime binaries, never the operator's runtime state.
const runtimeEntries=await readdir(join(payload,'.runtime'));if(runtimeEntries.join(',')!=='bin')throw new Error('Unexpected bundled runtime data');
const update=JSON.parse(await readFile('config/mac-update.json','utf8'));
const sdk=resolve('.runtime/vendor/sparkle-'+update.sparkle.version);
await mkdir(join(contents,'Frameworks'),{recursive:true});
await cp(join(sdk,'Sparkle.framework'),join(contents,'Frameworks/Sparkle.framework'),{recursive:true,verbatimSymlinks:true});
await cp(join(sdk,'LICENSE'),join(contents,'Resources/licenses/Sparkle.txt'));
const info=join(contents,'Info.plist');
await cp('native/DotLinkSetup/Info.plist',info);
for(const [key,type,value] of [
 ['SUFeedURL','string',`https://raw.githubusercontent.com/${update.repository}/${update.branch}/${update.feedPath}`],
 ['SUPublicEDKey','string',update.publicKey],['SURequireSignedFeed','bool','YES'],['SUVerifyUpdateBeforeExtraction','bool','YES'],
 ['DotLinkAutomaticUpdatesEnabled','bool',update.automaticUpdatesEnabled === true ? 'YES' : 'NO'],
 ['SUEnableAutomaticChecks','bool',update.automaticUpdatesEnabled === true ? 'YES' : 'NO'],['SUAutomaticallyUpdate','bool','NO'],['SUScheduledCheckInterval','integer','21600'],
 ['DotLinkUpdateRepository','string',update.downloadRepository ?? update.repository]
])run('/usr/libexec/PlistBuddy',['-c',`Add :${key} ${type} ${value}`,info]);
await cp('assets/brand/orbit/DotLink.icns',join(contents,'Resources/DotLink.icns'));
await mkdir('.runtime/swift-module-cache',{recursive:true});
run('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',resolve('.runtime/swift-module-cache'),'-target','arm64-apple-macos13.0','-framework','AppKit','-framework','ApplicationServices','-framework','UserNotifications','-F',sdk,'-framework','Sparkle','-Xlinker','-rpath','-Xlinker','@executable_path/../Frameworks','native/DotLinkSetup/AppUpdater.swift','native/NotificationMenu/DotStatus.swift','native/DotLinkSetup/NotificationReader.swift','native/DotLinkSetup/NotificationForwarder.swift','native/DotLinkSetup/NotificationStructureProbe.swift','native/DotLinkSetup/NotificationController.swift','native/DotLinkSetup/main.swift','-o',join(contents,'MacOS/DotLink')]);
for(const name of ['node','tunnel-client','whisper-cli'])run('/usr/bin/codesign',['--force','--sign','-',join(payload,'.runtime/bin',name)]);
run('/usr/bin/codesign',['--force','--sign','-','--identifier','app.tripsurf.dotlink.mac',output]);
run('/usr/bin/codesign',['--verify','--deep','--strict',output]);
console.log(JSON.stringify({app:output,architecture:'arm64',runtimePackages:copied.size,scope:'Local test build; not notarized or publicly distributed'}));
