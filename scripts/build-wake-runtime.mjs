// Maintainer-only rebuild. npm build uses the checked-in, hash-verified runtime.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { preparePinnedCheckout } from './lib/pinned-checkout.mjs';
const root=resolve('.'), work=resolve('.runtime/wake-runtime-build');
const manifestPath=join(root,'distribution/wake/manifest.json');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const source=join(work,'source'), sdk=join(work,'emsdk'), build=join(work,'build');
function run(command,args,cwd=work,env=process.env){const r=spawnSync(command,args,{cwd,env,stdio:'inherit'});if(r.status!==0)throw new Error(`${command} failed`);}
await mkdir(work,{recursive:true});
await preparePinnedCheckout({name:'sherpa-onnx',repository:'https://github.com/k2-fsa/sherpa-onnx.git',
  ref:`v${manifest.sherpaVersion}`,commit:manifest.sourceCommit,directory:source});
// emsdk is executed directly, so a version tag alone is not enough: pin and verify its commit first.
await preparePinnedCheckout({name:'emsdk',repository:'https://github.com/emscripten-core/emsdk.git',
  ref:manifest.emsdkVersion,commit:manifest.emsdkCommit,directory:sdk,clean:true});
run(join(sdk,'emsdk'),['install',manifest.emsdkVersion]);run(join(sdk,'emsdk'),['activate',manifest.emsdkVersion]);
const patch=join(root,'distribution/wake/runtime.patch');
const applied=spawnSync('git',['apply','--reverse','--check',patch],{cwd:source,stdio:'ignore'}).status===0;
if(!applied)run('git',['apply',patch],source);
// emcmake finds emcc through PATH. No shell profile or global configuration edits.
const env={...process.env,PATH:join(sdk,'upstream/emscripten')+':'+process.env.PATH,EMSDK:sdk,
  SHERPA_ONNX_IS_USING_BUILD_WASM_SH:'1'};
run(join(sdk,'upstream/emscripten/emcmake'),['cmake','-S',source,'-B',build,
  '-DCMAKE_BUILD_TYPE=Release','-DBUILD_SHARED_LIBS=OFF','-DSHERPA_ONNX_ENABLE_WASM=ON',
  '-DSHERPA_ONNX_ENABLE_WASM_WEB=ON','-DSHERPA_ONNX_ENABLE_TTS=OFF','-DSHERPA_ONNX_ENABLE_BINARY=OFF',
  '-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF','-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF',
  `-DCMAKE_C_FLAGS=-ffile-prefix-map=${work}=/dot-link-wake-build`,
  `-DCMAKE_CXX_FLAGS=-ffile-prefix-map=${work}=/dot-link-wake-build`],work,env);
run('cmake',['--build',build,'--target','sherpa-onnx-wasm-web','--parallel','4'],work,env);
const output=join(root,'distribution/wake');
const runtime=(await readFile(join(build,'bin/sherpa-onnx-wasm-web.js'),'utf8')).replaceAll('sherpa-onnx-wasm-web.wasm','runtime.wasm');
const wasm=await readFile(join(build,'bin/sherpa-onnx-wasm-web.wasm'));
if(wasm.includes(Buffer.from('/Users/'))||wasm.includes(Buffer.from(work)))throw new Error('Local paths in runtime');
await writeFile(join(output,'runtime.js'),runtime+'\nexport default SherpaOnnx;\n');
await writeFile(join(output,'runtime.wasm.gz'),gzipSync(wasm,{level:9}));
for(const [kind,symbol] of [['kws','Kws'],['vad','Vad']]){
  const original=await readFile(join(source,`wasm/${kind}/sherpa-onnx-${kind}.js`),'utf8');
  await writeFile(join(output,`${kind}.js`),`// Apache-2.0; sherpa-onnx v${manifest.sherpaVersion}. Scoped to avoid helper name collisions.\n(function () {\n${original}\nglobalThis.Dot${symbol} = { create${symbol} };\n})();\nexport default globalThis.Dot${symbol};\n`);
}
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const [name,info] of Object.entries(manifest.files)){
  if(!['runtime.js','runtime.wasm','kws.js','vad.js'].includes(name))continue;
  const data=info.local?await readFile(join(output,info.local)):wasm;
  info.bytes=data.length;info.sha256=hash(data);
  if(info.gzip)info.gzipSha256=hash(await readFile(join(output,info.gzip)));
}
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log('Rebuilt runtime. Review binaries, manifest, upstream licenses, and tests before committing.');
