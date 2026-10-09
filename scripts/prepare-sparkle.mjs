import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const {sparkle}=JSON.parse(await readFile('config/mac-update.json','utf8'));
if(!/^\d+\.\d+\.\d+$/.test(sparkle.version)||!/^[a-f0-9]{64}$/.test(sparkle.sha256))throw new Error('Invalid SDK pin');
const base=resolve('.runtime/vendor'),archive=join(base,`sparkle-download/Sparkle-${sparkle.version}.tar.xz`),destination=join(base,`sparkle-${sparkle.version}`);
await mkdir(join(base,'sparkle-download'),{recursive:true});
let bytes=await readFile(archive).catch(()=>null);
if(!bytes){const response=await fetch(`https://github.com/sparkle-project/Sparkle/releases/download/${sparkle.version}/Sparkle-${sparkle.version}.tar.xz`,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('SDK download failed');bytes=Buffer.from(await response.arrayBuffer());}
if(createHash('sha256').update(bytes).digest('hex')!==sparkle.sha256)throw new Error('SDK checksum mismatch');
await writeFile(archive,bytes);
await mkdir(destination,{recursive:true});
const result=spawnSync('/usr/bin/tar',['-xJf',archive,'-C',destination],{stdio:'inherit'});if(result.status!==0)throw new Error('SDK extraction failed');
console.log(`Verified Sparkle ${sparkle.version}`);
