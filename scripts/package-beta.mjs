import { readFile, readdir, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve('dist');
const manifest = JSON.parse(await readFile('app.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== pkg.version || manifest.min_sdk_version !== pkg.dependencies['@evenrealities/even_hub_sdk']) throw new Error('Manifest and dependency versions differ');
const secrets = [];
for (const name of ['device-key', 'mcp-key', 'notification-key']) {
  try { const value = (await readFile(join('.runtime', name), 'utf8')).trim(); if (value.length >= 32) secrets.push(value); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const files = [];
async function inspect(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const file = join(directory, name); const info = await lstat(file);
    if (info.isSymbolicLink() || name.startsWith('.')) throw new Error('Hidden file or symlink in release assets');
    if (info.isDirectory()) { await inspect(file); continue; }
    if (!/\.(?:html|js|css|svg|txt|png)$/.test(name) || info.size > 2000000) throw new Error('Unexpected release asset');
    const data = await readFile(file); const text = data.toString('utf8');
    if (/\/Users\/|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|Bearer [A-Za-z0-9_-]{32,}|https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/.test(text) || secrets.some(value => text.includes(value))) throw new Error('Private configuration found in release assets');
    files.push({path:relative(root,file),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
  }
}
await inspect(root);
if (!files.some(file => file.path === manifest.entrypoint)) throw new Error('Missing entrypoint');
await mkdir('.runtime/release', {recursive:true,mode:0o700});
const output = resolve(`.runtime/release/dot-link-${manifest.version}.ehpk`);
const candidate = `${output}.candidate-${process.pid}`;
const result = spawnSync(process.execPath, ['tools/evenhub/node_modules/@evenrealities/evenhub-cli/main.js',
  'pack', 'app.json', 'dist', '--sdk-ver', manifest.min_sdk_version, '-o', candidate], {encoding:'utf8'});
const packingLog = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const minimumApp = packingLog.match(/min_app_version (\d+\.\d+\.\d+)\s+\(SDK ([0-9.]+), --sdk-ver\)/);
if (result.status !== 0 || /WARNING|default floor|fallback/i.test(packingLog) || minimumApp?.[2] !== manifest.min_sdk_version) {
  await rm(candidate,{force:true});
  throw new Error('Package not released: the CLI must verify the SDK app-version floor online without fallback. Check network access and run again.');
}
await rename(candidate,output);
const data = await readFile(output);
const receipt = {version:manifest.version,sdk:manifest.min_sdk_version,minAppVersion:minimumApp[1],cli:'0.1.14',
  scope:'Self-only beta candidate; not approved for public submission',
  unresolved:['Runtime relay destination permission is not established by an empty manifest whitelist','Physical beta validation pending'],
  bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),files};
await writeFile(`${output}.json`, JSON.stringify(receipt,null,2)+'\n', {mode:0o600});
console.log(JSON.stringify({package:output,bytes:receipt.bytes,sha256:receipt.sha256,scope:receipt.scope}));
