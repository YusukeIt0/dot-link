import {readFileSync, existsSync, realpathSync} from 'node:fs';
import {resolve, dirname, relative} from 'node:path';
import assert from 'node:assert/strict';

// Changed Markdown only; remote availability and prose correctness remain review concerns.
export function checkDocs(paths, root = process.cwd()) {
  root = realpathSync(root);
  for (const path of paths.filter(p => p.endsWith('.md'))) {
    const body = readFileSync(resolve(root, path), 'utf8');
    if (path === 'README.md') assert.equal(body.match(/```sh\n([^]*?)\n```/)?.[1],
      'curl -fsS https://raw.githubusercontent.com/YusukeIt0/dot-link/main/install.sh | /bin/bash', 'README must retain the recommended latest-release install command');
    if (/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(body)) throw new Error(`Conflict marker in ${path}`);
    for (const match of body.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) continue;
      const target = decodeURIComponent(href.split(/[?#]/)[0]);
      if (!target) continue;
      const destination = resolve(dirname(resolve(root, path)), target);
      if (!existsSync(destination) || relative(root, realpathSync(destination)).startsWith('..')) throw new Error(`Missing or external local link in ${path}: ${target}`);
    }
  }
}
