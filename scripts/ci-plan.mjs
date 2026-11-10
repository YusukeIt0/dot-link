// Shared impact selection. No network, dependencies, labels or author overrides.
import {execFileSync} from 'node:child_process';
import {readFileSync, appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {discoverReuse, githubReader, reuseContext} from './ci-reuse.mjs';

export const macPlist = 'native/DotLinkSetup/Info.plist';
export const macFeed = 'updates/mac/appcast.xml';
const sha = s => /^[a-f0-9]{40}$/.test(s || '') && !/^0+$/.test(s);
const git = (args, cwd = '.') => execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 4_000_000, stdio: ['pipe', 'pipe', 'pipe']});
export function plist(text) {
  return JSON.parse(execFileSync('python3', ['-c', 'import sys,json,plistlib; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'],
    {input: text, encoding: 'utf8', maxBuffer: 100_000, stdio: ['pipe', 'pipe', 'pipe']}));
}
export function versionOnly(before, after) {
  try {
    const a = plist(before), b = plist(after);
    const build = value => typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value);
    const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
    if (!build(a.CFBundleVersion) || !build(b.CFBundleVersion) || +b.CFBundleVersion <= +a.CFBundleVersion ||
        !version(a.CFBundleShortVersionString) || !version(b.CFBundleShortVersionString)) return false;
    const key = value => value.split('.').map(s => s.padStart(4, '0')).join('.');
    if (key(b.CFBundleShortVersionString) < key(a.CFBundleShortVersionString)) return false;
    const mask = text => {
      for (const k of ['CFBundleVersion', 'CFBundleShortVersionString']) {
        const pattern = new RegExp(`(<key>${k}</key>\\s*<string>)[^<]*(</string>)`, 'g');
        if ([...text.matchAll(pattern)].length !== 1) throw new Error('Ambiguous version field');
        text = text.replace(pattern, '$1VERSION$2');
      }
      return text;
    };
    return mask(before) === mask(after);
  } catch { return false; }
}

export function classify(changes, read, protectedPaths = []) {
  const full = reason => ({checks: changes.some(f => f.path === macFeed) ? ['product', 'feed'] : ['product'], runner: 'macos-15', reason});
  if (!changes.length || changes.length > 300) return full('Empty or oversized comparison.');
  const checks = new Set();
  for (const f of changes) {
    if (!['A', 'M'].includes(f.status) || !['000000', '100644'].includes(f.oldMode) || f.newMode !== '100644' ||
        !/^[\w./-]+$/.test(f.path) || f.path.split('/').some(p => p === '..' || p === '.')) return full('Non-regular, deleted, renamed or unsafe path.');
    if (protectedPaths.some(p => f.path === p || p.endsWith('/') && f.path.startsWith(p))) return full('Protected control-plane change.');
    if (f.path === 'README.md' || /^docs\/[\w/-]+\.md$/.test(f.path)) checks.add('docs');
    else if (/^site\/[\w./-]+\.(?:html|css|mjs|json)$/.test(f.path) || /^assets\/(?:readme|film)\/[\w.-]+\.(?:png|jpg|mp4|vtt)$/.test(f.path)) checks.add('site');
    else if (f.path === macPlist && f.status === 'M' && versionOnly(read('base', f.path), read('head', f.path))) checks.add('version');
    else if (f.path === macFeed && f.status === 'M') checks.add('feed');
    else return full('Runtime, dependency, test, packaging or unclassified change.');
  }
  return {checks: [...checks].sort(), runner: 'ubuntu-latest', reason: 'All changed files have bounded non-runtime checks; run their union.'};
}

export function plan(base, head, cwd = '.') {
  const full = reason => ({base: sha(base) ? base : null, head: sha(head) ? head : null, checks: ['product'], runner: 'macos-15', reason, paths: []});
  try {
    if (!sha(base) || !sha(head) || git(['merge-base', base, head], cwd).trim() !== base) return full('Missing comparison or base is not an ancestor.');
    // Narrow checks inherit unchanged product coverage only from integrated main.
    // An unmerged parent branch is not a validated baseline, even for a docs child.
    if (git(['merge-base', base, 'origin/main'], cwd).trim() !== base) return full('Baseline is not integrated into main.');
    // --no-renames exposes both deletion and addition; deletion forces full scope.
    const fields = git(['diff', '--raw', '-z', '--no-renames', base, head, '--'], cwd).split('\0');
    fields.pop();
    if (fields.length % 2) throw new Error('Incomplete diff');
    const changes = [];
    for (let i = 0; i < fields.length; i += 2) {
      const match = fields[i].match(/^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/);
      if (!match) throw new Error('Unexpected diff');
      changes.push({oldMode: match[1], newMode: match[2], status: match[3], path: fields[i + 1]});
    }
    const read = (revision, path) => git(['show', `${revision === 'base' ? base : head}:${path}`], cwd);
    const protectedPaths = JSON.parse(read('base', 'config/development-policy.json')).protectedPaths;
    if (!Array.isArray(protectedPaths)) throw new Error('Missing policy');
    return {base, head, ...classify(changes, read, protectedPaths), paths: changes.map(f => f.path)};
  } catch { return full('Comparison unavailable or not safely classifiable.'); }
}

export function eventRevisions(eventName, event) {
  if (eventName === 'pull_request') return {base: event.pull_request?.base?.sha, head: event.pull_request?.head?.sha};
  if (eventName === 'push') return {base: event.ref === 'refs/heads/main' ? event.before : null, head: event.after};
  return {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let [base, head] = process.argv.slice(2);
  if (base === '--event') {
    ({base, head} = eventRevisions(process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))));
    // Branch validation covers the whole branch, not only its last push.
    if (!base && process.env.GITHUB_EVENT_NAME === 'push') {
      try { base = git(['merge-base', 'origin/main', head]).trim(); } catch {}
    }
  }
  const result = plan(base, head);
  // Keep impact classification intact. Only CI may substitute proven execution.
  const reuse = process.argv[2] === '--event' && result.checks.includes('product')
    ? await discoverReuse(reuseContext({...process.env, CI_HEAD: result.head}), githubReader(process.env.GH_TOKEN)) : null;
  if (reuse) {
    result.reuse = reuse;
    result.runner = 'ubuntu-latest';
  }
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `runner=${result.runner}\nbase=${result.base || ''}\nhead=${result.head || ''}\nproduct=${result.checks.includes('product')}\nreuse=${reuse?.run || ''}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Change impact\n\n- Base: ${result.base || 'unavailable'}\n- Head: ${result.head || 'unavailable'}\n- Checks: ${result.checks.join(', ')}\n- Reason: ${result.reason}\n- Changed files: ${result.paths.length}\n`);
  if (reuse && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `- Reuse candidate: [run ${reuse.run}](${reuse.url}), tree ${reuse.tree}; consuming job must reverify.\n`);
}
