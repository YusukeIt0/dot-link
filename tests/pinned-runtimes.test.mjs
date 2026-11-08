import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compareVersions, parseVersion, readPins, nodeStatus, releaseStatus, renderIssue, decide, marker, sources, nodeWorkflows, eolWarningDays } from '../scripts/check-pinned-runtimes.mjs';

const index = [
  { version: 'v24.11.0', npm: '11.6.0', lts: 'Krypton', security: false },
  { version: 'v22.24.0', npm: '10.9.10', lts: 'Jod', security: true },
  { version: 'v22.23.4', npm: '10.9.9', lts: 'Jod', security: true },
  { version: 'v22.23.3', npm: '10.9.9', lts: 'Jod', security: false },
];
const ci = [{ path: '.github/workflows/ci.yml', values: ['22.23.4'] }];
const sparkle = sources.find(source => source.id === 'sparkle');

test('versions compare numerically and reject unrecognized forms', () => {
  assert.deepEqual(parseVersion('v1.9.5'), [1, 9, 5]);
  assert.equal(compareVersions('2.10.1', '2.10.0'), 1);
  assert.equal(compareVersions('v0.0.16', 'v0.0.20'), -1);
  assert.equal(compareVersions('v22.9.0', 'v22.23.4'), -1);
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
  for (const bad of ['2.10', '2.10.0-beta.1', 'latest', '']) assert.throws(() => compareVersions(bad, '1.0.0'));
});

test('repository pins are read from the real files and every Node pin is consistent', () => {
  const pins = readPins();
  for (const key of ['node', 'sparkle', 'tunnel', 'whisper']) assert.ok(parseVersion(pins[key]), key);
  assert.deepEqual(pins.nodeCi.map(row => row.path), nodeWorkflows);
  // Every workflow that pins Node is covered, so a CI-only bump cannot drift unnoticed.
  const pinned = readdirSync('.github/workflows').filter(file => /node-version:\s*'/.test(readFileSync(`.github/workflows/${file}`, 'utf8')));
  assert.deepEqual(pinned.map(file => `.github/workflows/${file}`).sort(), [...nodeWorkflows].sort());
  const schedule = { [`v${parseVersion(pins.node)[0]}`]: { end: '2099-01-01' } };
  assert.deepEqual(nodeStatus([{ version: pins.node, npm: '10.9.9', security: false }], pins.node, pins.nodeCi, schedule).findings, []);
});

test('Node status stays on the pinned major, flags security releases and npm, and detects CI drift', () => {
  const status = nodeStatus(index, 'v22.23.4', ci);
  assert.equal(status.latest, 'v22.24.0');
  assert.equal(status.outdated, true);
  assert.equal(status.security, true);
  assert.deepEqual(status.npm, { pinned: '10.9.9', latest: '10.9.10' });
  const current = nodeStatus(index.slice(2), 'v22.23.4', ci);
  assert.equal(current.outdated, false); assert.equal(current.security, false);
  assert.match(nodeStatus(index, 'v22.23.4', [{ path: 'x.yml', values: ['22.23.3'] }]).findings.join(), /x.yml uses 22.23.3/);
  assert.match(nodeStatus(index, 'v22.99.0', ci).findings.join(), /not in the official release list/);
});

test('release status reports newer versions and only advisories after the pinned release', () => {
  const advisories = [
    { ghsa_id: 'GHSA-new', state: 'published', severity: 'high', summary: 'Signature bypass', published_at: '2026-10-01T00:00:00Z', html_url: 'https://example.test/new' },
    { ghsa_id: 'GHSA-old', state: 'published', severity: 'low', summary: 'Old', published_at: '2025-01-01T00:00:00Z', html_url: 'https://example.test/old' },
    { ghsa_id: 'GHSA-draft', state: 'draft', severity: 'high', summary: 'Draft', published_at: '2026-10-02T00:00:00Z', html_url: 'https://example.test/d' },
  ];
  const status = releaseStatus(sparkle, '2.10.0', { tag_name: '2.10.1', html_url: 'https://example.test/rel' }, advisories, '2026-06-01T00:00:00Z');
  assert.equal(status.outdated, true); assert.equal(status.security, true);
  assert.deepEqual(status.advisories.map(a => a.id), ['GHSA-new']);
  const same = releaseStatus(sparkle, '2.10.1', { tag_name: '2.10.1', html_url: 'x' }, [], null);
  assert.equal(same.outdated, false); assert.equal(same.security, false);
  assert.throws(() => releaseStatus(sparkle, '2.10.0', {}, [], null));
});

test('a failed advisory lookup is unknown, stays actionable and never closes the tracking issue', () => {
  const unknown = releaseStatus(sparkle, '2.10.1', { tag_name: '2.10.1', html_url: 'x' }, null, null);
  assert.equal(unknown.outdated, false); assert.equal(unknown.security, null);
  assert.match(unknown.findings.join(), /Advisory lookup failed/);
  const report = renderIssue([unknown], '2026-11-09');
  assert.equal(report.actionable, 1);
  assert.match(report.body, /\| Sparkle \| 2\.10\.1 \| 2\.10\.1 \| unknown \|/);
  assert.doesNotMatch(report.body, /Why no automatic PR/);
  assert.equal(decide({ number: 5, body: 'old' }, report).action, 'update');
});

test('the tracking issue explains each actionable runtime and stays quiet when everything is current', () => {
  const rows = [nodeStatus(index.slice(2), 'v22.23.4', ci, { v22: { end: '2099-01-01' } }),
    releaseStatus(sparkle, '2.10.0', { tag_name: '2.10.1', html_url: 'https://example.test/rel' }, [], null)];
  const report = renderIssue(rows, '2026-11-09');
  assert.equal(report.actionable, 1);
  assert.ok(report.body.startsWith(marker));
  assert.match(report.body, /### Sparkle\n- Update available: 2\.10\.0 → 2\.10\.1\./);
  assert.match(report.body, /Why no automatic PR: version and sha256/);
  assert.match(report.body, /Next action:/);
  assert.doesNotMatch(report.body, /### Node\.js/);
  assert.equal(renderIssue([rows[0]], '2026-11-09').actionable, 0);
});

test('one tracking issue is created, updated in place, left alone when unchanged and closed when current', () => {
  const report = { body: `${marker}\nchecked 2026-11-09. table`, actionable: 1 };
  assert.deepEqual(decide(undefined, report), { action: 'create' });
  assert.deepEqual(decide({ number: 5, body: `${marker}\nchecked 2026-11-02. table` }, report), { action: 'none', number: 5 });
  assert.deepEqual(decide({ number: 5, body: `${marker}\nchecked 2026-11-02. other` }, report), { action: 'update', number: 5 });
  assert.deepEqual(decide({ number: 5, body: 'x' }, { body: '', actionable: 0 }), { action: 'close', number: 5 });
  assert.deepEqual(decide(undefined, { body: '', actionable: 0 }), { action: 'none' });
});

test('end-of-life of the pinned Node major is reported before it happens and when the schedule is unknown', () => {
  const schedule = { v22: { end: '2027-04-30' }, v24: { end: '2028-04-30' } };
  const far = nodeStatus(index.slice(2), 'v22.23.4', ci, schedule, '2026-06-01');
  assert.deepEqual(far.findings, []); assert.equal(far.eol.end, '2027-04-30');
  const near = nodeStatus(index.slice(2), 'v22.23.4', ci, schedule, '2026-11-09');
  assert.ok(near.eol.days <= eolWarningDays);
  assert.match(near.findings.join(), /reaches end-of-life on 2027-04-30 \(in 172 days\)/);
  assert.match(nodeStatus(index, 'v22.23.4', ci, schedule, '2026-11-09').findings.join(), /latest LTS: v24\.11\.0/);
  assert.match(nodeStatus(index.slice(2), 'v22.23.4', ci, schedule, '2027-05-10').findings.join(), /10 days ago/);
  assert.match(nodeStatus(index.slice(2), 'v22.23.4', ci, null).findings.join(), /schedule unavailable/);
  assert.match(nodeStatus(index.slice(2), 'v22.23.4', ci, { v20: {} }).findings.join(), /No end-of-life date/);
  // An end-of-life finding keeps the tracking issue open even when no newer release exists.
  assert.equal(renderIssue([near], '2026-11-09').actionable, 1);
});
