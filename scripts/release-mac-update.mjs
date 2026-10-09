// Publisher only. The client does not run gh or receive this signing key.
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const config=JSON.parse(await readFile('config/mac-update.json','utf8'));
const downloadRepository=config.downloadRepository ?? config.repository;
if(config.private!==false)throw new Error('Only the public update channel is supported');
const app=resolve(process.argv[2]??'.runtime/mac-app/Dot Link.app'),notesFile=process.argv[3];
if(!notesFile)throw new Error('Usage: node scripts/release-mac-update.mjs <app> <release-notes.txt>');
const key=resolve('.runtime/update-signing/ed25519.key'),signer=resolve(`.runtime/vendor/sparkle-${config.sparkle.version}/bin/sign_update`);
if((await stat(key)).mode&0o077)throw new Error('Signing key permissions must be 600');
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:10e6});if(r.status!==0)throw new Error(`${cmd} failed (${r.status})`);return r.stdout.trim();};
const info=join(app,'Contents/Info.plist'),field=k=>run('/usr/libexec/PlistBuddy',['-c','Print :'+k,info]);
const version=field('CFBundleShortVersionString'),build=field('CFBundleVersion');
if(!/^\d+\.\d+\.\d+$/.test(version)||!/^\d+$/.test(build)||field('SUPublicEDKey')!==config.publicKey||field('CFBundleIdentifier')!=='app.tripsurf.dotlink.mac')throw new Error('Unexpected bundle identity or key');
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const repository=JSON.parse(run('gh',['api','repos/'+config.repository]));
if(repository.private!==config.private)throw new Error('Repository visibility differs from configured channel');
const notes=await readFile(notesFile,'utf8');
const commit=run('gh',['api',`repos/${config.repository}/commits/${config.branch}`,'--jq','.sha']);
const directory=resolve('.runtime/release/mac-updates');await mkdir(directory,{recursive:true});
const name=`Dot-Link-${version}-${build}-arm64.zip`,archive=join(directory,name),tag=`mac-v${version}-${build}`;
try{await stat(archive);throw new Error('Archive already exists; use a new build');}catch(e){if(e.code!=='ENOENT')throw e;}
run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,archive]);
const signature=run(signer,['--ed-key-file',key,'-p',archive]);
run(signer,['--verify','--ed-key-file',key,archive,signature]);
run('gh',['release','create',tag,archive,'--repo',config.repository,'--target',commit,'--title',`Dot Link for Mac ${version}`,'--notes-file',resolve(notesFile),'--draft']);
// A draft's tag lookup may return 404 until publication. List authenticated drafts instead.
const release=JSON.parse(run('gh',['api',`repos/${config.repository}/releases?per_page=100`])).find(item=>item.tag_name===tag);
if(!release)throw new Error('Draft release not found');
const asset=release.assets.find(a=>a.name===name);if(!asset)throw new Error('Release asset missing');
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const feed=`<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Dot Link for Mac</title><item><title>Dot Link ${version}</title><sparkle:version>${build}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><description sparkle:format="plain-text">${xml(notes)}</description><enclosure url="https://github.com/${downloadRepository}/releases/download/${tag}/${name}" sparkle:installationType="application" sparkle:edSignature="${xml(signature)}" length="${asset.size}" type="application/octet-stream" /></item></channel></rss>\n`;
await mkdir('updates/mac',{recursive:true});const feedFile=resolve(config.feedPath);await writeFile(feedFile,feed);
run(signer,['--ed-key-file',key,feedFile]);run(signer,['--verify','--ed-key-file',key,feedFile]);
run('gh',['release','edit',tag,'--repo',config.repository,'--draft=false']);
run('/usr/bin/curl',['--fail','--silent','--show-error','--head','--location','--max-time','30',`https://github.com/${downloadRepository}/releases/download/${tag}/${name}`]);
console.log(JSON.stringify({tag,assetID:asset.id,feed:config.feedPath,next:'Review and commit the signed feed, then push. Repository visibility is unchanged.'}));
