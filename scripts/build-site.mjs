import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.site/dot-link');
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'assets'), { recursive: true });

// Copy only public page files and existing approved artwork, never the app build.
for (const file of ['index.html', 'style.css', 'sitemap.xml']) {
  await copyFile(resolve(root, 'site', file), resolve(output, file));
}
for (const [source, name] of [
  ['assets/brand/orbit/mark.svg', 'mark.svg'],
  ['assets/brand/orbit/mac-1024.png', 'mac-1024.png'],
  ['assets/readme/conversation-en.png', 'conversation-en.png'],
]) {
  await copyFile(resolve(root, source), resolve(output, 'assets', name));
}
console.log(`Static page ready: ${output}`);
