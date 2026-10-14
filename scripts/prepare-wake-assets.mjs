import { readFile, writeFile, mkdir, rename, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { wakeManifest, sha256, verifyWakeAssets } from './lib/wake-assets.mjs';

const run = promisify(execFile);
const root = resolve('public/wake-assets'), cache = resolve('.runtime/wake-assets-cache');
const local = resolve('distribution/wake');
try { await verifyWakeAssets(root); console.log('Wake assets verified'); process.exit(0); } catch {}
await mkdir(root, { recursive: true }); await mkdir(cache, { recursive: true });
// Recover only known temporary names from older preparers; retain the strict
// check for every other unexpected file instead of deleting arbitrary content.
for (const name of await readdir(root)) {
  const match = name.match(/^(.*)\.tmp-\d+$/);
  if (match && Object.hasOwn(wakeManifest.files, match[1])) await rm(join(root, name), { force: true });
}
const downloads = new Map();
async function download(key) {
  if (downloads.has(key)) return downloads.get(key);
  const info = wakeManifest.downloads[key], path = join(cache, info.sha256);
  let bytes;
  try { bytes = await readFile(path); } catch {}
  if (!bytes || bytes.length !== info.bytes || sha256(bytes) !== info.sha256) {
    const response = await fetch(info.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Wake download failed: ${key} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== info.bytes || sha256(bytes) !== info.sha256) throw new Error(`Wake download integrity check failed: ${key}`);
    await writeFile(path, bytes);
  }
  const result = { path, bytes }; downloads.set(key, result); return result;
}
for (const [name, info] of Object.entries(wakeManifest.files)) {
  let bytes;
  if (info.local) bytes = await readFile(join(local, info.local));
  else if (info.gzip) {
    const compressed = await readFile(join(local, info.gzip));
    if (sha256(compressed) !== info.gzipSha256) throw new Error('Wake runtime integrity check failed');
    bytes = gunzipSync(compressed, { maxOutputLength: info.bytes });
  } else if (info.download) bytes = (await download(info.download)).bytes;
  else {
    const archive = await download(info.archive);
    ({ stdout: bytes } = await run('tar', ['-xOf', archive.path, info.entry], { encoding: 'buffer', maxBuffer: info.bytes + 1024 }));
  }
  if (bytes.length !== info.bytes || sha256(bytes) !== info.sha256) throw new Error(`Wake asset integrity check failed: ${name}`);
  const target = join(root, name), temporary = join(cache, `prepare-${name}.tmp-${process.pid}`);
  try { await writeFile(temporary, bytes); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
await verifyWakeAssets(root);
console.log('Wake assets prepared and verified');
