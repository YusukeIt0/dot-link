// Weekly watch for pinned runtimes that Dependabot cannot track (#274).
// It never edits pins or checksums: it reports newer upstream versions and
// advisories in one tracking issue so a reviewed PR can update each version
// together with its integrity data.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const marker = '<!-- dot-link-pinned-runtime-watch:v1 -->';
export const title = 'Pinned runtime updates available';
export const nodeWorkflows = ['.github/workflows/ci.yml', '.github/workflows/branch-ci.yml', '.github/workflows/pages.yml', '.github/workflows/pinned-runtime-watch.yml'];
export const sources = [
  { id: 'sparkle', name: 'Sparkle', repo: 'sparkle-project/Sparkle', file: 'config/mac-update.json',
    integrity: 'version and sha256 in `config/mac-update.json` (verified by `scripts/prepare-sparkle.mjs`)' },
  { id: 'tunnel', name: 'tunnel-client', repo: 'openai/tunnel-client', file: 'scripts/mac-runtime-manifest.json',
    integrity: 'version, URL and sha256 in `scripts/mac-runtime-manifest.json`' },
  { id: 'whisper', name: 'whisper.cpp', repo: 'ggml-org/whisper.cpp', file: 'scripts/mac-runtime-manifest.json',
    integrity: 'version, URL and sha256 in `scripts/mac-runtime-manifest.json`' },
];

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`Unrecognized version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// Read every pin from the repository; inconsistent Node pins are themselves a finding.
export function readPins(read = path => readFileSync(path, 'utf8')) {
  const manifest = JSON.parse(read('scripts/mac-runtime-manifest.json'));
  const update = JSON.parse(read('config/mac-update.json'));
  const ci = nodeWorkflows.map(path => {
    const values = [...read(path).matchAll(/node-version:\s*'([^']+)'/g)].map(match => match[1]);
    return { path, values };
  });
  return { node: manifest.node.version, nodeCi: ci, sparkle: update.sparkle.version,
    tunnel: manifest.tunnel.version, whisper: manifest.whisper.version };
}

export const eolWarningDays = 180;
// index.json is nodejs.org's release list (newest first) with npm and security flags.
// schedule is nodejs/Release schedule.json (null when unavailable): end-of-life of the
// pinned major cannot be seen from releases alone, because none appear after it.
export function nodeStatus(index, pinned, ci, schedule = null, today = new Date().toISOString().slice(0, 10)) {
  const major = parseVersion(pinned)?.[0];
  if (major === undefined) throw new Error('Unrecognized Node pin');
  const line = index.filter(row => parseVersion(row.version)?.[0] === major);
  const current = line.find(row => row.version === pinned);
  const latest = line.reduce((best, row) => !best || compareVersions(row.version, best.version) > 0 ? row : best, null);
  const newer = line.filter(row => compareVersions(row.version, pinned) > 0);
  const findings = [];
  const mismatched = ci.flatMap(({ path, values }) => values.filter(value => `v${value}` !== pinned).map(value => `${path} uses ${value}`));
  if (!current) findings.push(`Pinned ${pinned} is not in the official release list.`);
  if (mismatched.length) findings.push(`CI and the bundled runtime differ: ${mismatched.join('; ')} (bundled ${pinned}).`);
  if (!ci.some(({ values }) => values.length)) findings.push('No CI node-version pin was found.');
  const latestLts = index.filter(row => row.lts).reduce((best, row) => !best || compareVersions(row.version, best.version) > 0 ? row : best, null);
  const end = schedule?.[`v${major}`]?.end;
  let eol = null;
  if (!schedule) findings.push('Node.js release schedule unavailable, so end-of-life status is unknown. Rerun the watch or check https://github.com/nodejs/Release.');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(end ?? '')) findings.push(`No end-of-life date for Node.js ${major} in the release schedule.`);
  else {
    const days = Math.round((Date.parse(end) - Date.parse(today)) / 86_400_000);
    eol = { end, days };
    if (days <= eolWarningDays) findings.push(`Node.js ${major} reaches end-of-life on ${end} (${days < 0 ? `${-days} days ago` : `in ${days} days`}). Plan the bundled runtime and CI move to a supported LTS major${latestLts && parseVersion(latestLts.version)[0] > major ? ` (latest LTS: ${latestLts.version})` : ''}.`);
  }
  return {
    id: 'node', name: `Node.js ${major} (CI and bundled Mac runtime)`, pinned, latest: latest?.version ?? pinned,
    outdated: newer.length > 0, security: newer.some(row => row.security === true), eol,
    npm: { pinned: current?.npm ?? 'unknown', latest: latest?.npm ?? 'unknown' },
    link: latest ? `https://nodejs.org/en/blog/release/${latest.version}` : 'https://nodejs.org/en/about/previous-releases',
    integrity: 'version, URL and sha256 in `scripts/mac-runtime-manifest.json` (official SHASUMS256), plus node-version in CI workflows',
    findings,
  };
}

// `advisories === null` means the lookup failed: security status is unknown, never "no".
export function releaseStatus(source, pinned, latest, advisories, pinnedPublishedAt) {
  if (!latest?.tag_name) throw new Error(`No latest release for ${source.repo}`);
  const relevant = (advisories ?? []).filter(a => a.state === 'published' && (!pinnedPublishedAt || a.published_at > pinnedPublishedAt))
    .map(a => ({ id: a.ghsa_id, severity: a.severity ?? 'unknown', summary: String(a.summary ?? '').slice(0, 160), url: a.html_url }));
  return {
    id: source.id, name: source.name, pinned, latest: latest.tag_name,
    outdated: compareVersions(latest.tag_name, pinned) > 0,
    security: advisories === null ? null : relevant.length > 0, advisories: relevant,
    link: latest.html_url, integrity: source.integrity,
    findings: advisories === null ? ['Advisory lookup failed, so security status is unknown. Rerun the watch or check upstream advisories manually.'] : [],
  };
}

const cell = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
export function renderIssue(rows, checkedAt) {
  const actionable = rows.filter(row => row.outdated || row.security || row.findings.length);
  const lines = [marker, '', `Weekly pinned-runtime watch, checked ${checkedAt}. Dependabot does not track these pins, so this issue reports them instead of opening an automatic PR: each update must change the version together with its URL/checksum and keep integrity verification. See [dependency updates](https://github.com/YusukeIt0/dot-link/blob/main/docs/dependency-updates.md).`, '',
    '| Runtime | Pinned | Latest | Security | Upstream |', '| --- | --- | --- | --- | --- |'];
  for (const row of rows) {
    const npm = row.npm ? ` (npm ${row.npm.pinned} → ${row.npm.latest})` : '';
    const security = row.security === null ? 'unknown' : row.security ? 'yes' : 'no';
    lines.push(`| ${cell(row.name)} | ${cell(row.pinned)}${npm} | ${cell(row.latest)}${row.outdated ? ' (newer)' : ''} | ${security} | [release](${row.link}) |`);
  }
  for (const row of actionable) {
    lines.push('', `### ${row.name}`);
    if (row.outdated) lines.push(`- Update available: ${row.pinned} → ${row.latest}.`);
    for (const advisory of row.advisories ?? []) lines.push(`- Advisory [${advisory.id}](${advisory.url}) (${advisory.severity}): ${cell(advisory.summary)}. Reported upstream; exposure in Dot Link is not established by this watch.`);
    if (row.id === 'node' && row.security) lines.push('- A newer release on this line is marked as a security release.');
    for (const finding of row.findings) lines.push(`- ${finding}`);
    if (row.outdated || row.security) {
      lines.push(`- Why no automatic PR: ${row.integrity} must change together and be verified against upstream before review.`);
      lines.push('- Next action: prepare a PR that updates the version and integrity data, run the existing checks, and record the source/build identity for the maintainer decision.');
    }
  }
  return { body: lines.join('\n') + '\n', actionable: actionable.length };
}

// Pure decision used by the CLI and tests: one tracking issue, updated in place.
export function decide(existing, report) {
  if (report.actionable === 0) return existing ? { action: 'close', number: existing.number } : { action: 'none' };
  if (!existing) return { action: 'create' };
  const unchanged = existing.body?.replace(/checked [^.]+\./, '') === report.body.replace(/checked [^.]+\./, '');
  return unchanged ? { action: 'none', number: existing.number } : { action: 'update', number: existing.number };
}

async function json(url, token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dot-link-pinned-runtime-watch' };
  if (token && url.startsWith('https://api.github.com/')) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} request failed: ${response.status}`);
  return response.json();
}

async function main() {
  const token = process.env.GH_TOKEN;
  const pins = readPins();
  let schedule = null;
  try { schedule = await json('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'); } catch { /* Unknown, reported as a finding. */ }
  const rows = [nodeStatus(await json('https://nodejs.org/dist/index.json'), pins.node, pins.nodeCi, schedule)];
  for (const source of sources) {
    const api = `https://api.github.com/repos/${source.repo}`;
    const latest = await json(`${api}/releases/latest`, token);
    let pinnedRelease = null;
    try { pinnedRelease = await json(`${api}/releases/tags/${encodeURIComponent(pins[source.id])}`, token); } catch { /* Tag without a release: compare advisories from all time. */ }
    let advisories = null;
    try { advisories = await json(`${api}/security-advisories?state=published&per_page=50`, token); } catch { /* Unknown, reported as a finding; never treated as no advisories. */ }
    rows.push(releaseStatus(source, pins[source.id], latest, advisories, pinnedRelease?.published_at));
  }
  const report = renderIssue(rows, new Date().toISOString().slice(0, 10));
  console.log(report.body);
  if (!process.argv.includes('--issue')) return;
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  // Not search: the index lags. Only an issue opened by this workflow's bot counts.
  const open = JSON.parse(gh(['issue', 'list', '--state', 'open', '--json', 'number,body,author', '--limit', '200']))
    .find(issue => issue.body?.startsWith(marker) && issue.author?.login === 'app/github-actions');
  const decision = decide(open, report);
  if (decision.action === 'create') gh(['issue', 'create', '--title', title, '--body', report.body]);
  if (decision.action === 'update') gh(['issue', 'edit', String(decision.number), '--body', report.body]);
  if (decision.action === 'close') gh(['issue', 'close', String(decision.number), '--comment', `All pinned runtimes are current as of ${new Date().toISOString().slice(0, 10)}.`]);
  console.log(`Tracking issue: ${decision.action}${decision.number ? ` #${decision.number}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
