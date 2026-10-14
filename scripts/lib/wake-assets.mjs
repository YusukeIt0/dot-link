import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const wakeManifest = JSON.parse(await readFile(new URL('../../distribution/wake/manifest.json', import.meta.url), 'utf8'));
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export async function verifyWakeAssets(root) {
  const names = (await readdir(root)).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(wakeManifest.files).sort())) throw new Error('Unexpected wake assets');
  for (const [name, expected] of Object.entries(wakeManifest.files)) {
    const path = join(root, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes || sha256(await readFile(path)) !== expected.sha256) {
      throw new Error(`Wake asset integrity check failed: ${name}`);
    }
  }
}
