import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compareVersions, parseVersion, readPins, nodeStatus, releaseStatus, renderIssue, decide, marker, sources, nodeWorkflows, eolWarningDays, reviewTarget, reviewState, materiallyActionable, withReviewState, readReviewState, pinnedLookupTransient, readAssessments, assessmentFile } from '../scripts/check-pinned-runtimes.mjs';

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

test('only a new or materially changed actionable report requests the dotsweeper issue review (#368)', () => {
  const node = (patch = {}) => ({ id: 'node', pinned: 'v26.13.1', latest: 'v26.13.1', outdated: false, security: false, eol: { end: '2029-04-30', days: 900 }, findings: [], ...patch });
  const tunnel = (patch = {}) => ({ id: 'tunnel', pinned: 'v0.0.21', latest: 'v0.0.22', outdated: true, security: false, advisories: [], findings: [], ...patch });
  const base = reviewState([node(), tunnel()]);
  assert.equal(materiallyActionable(base), true);
  // Not material: a countdown inside the warning window, a failed lookup, and its recovery.
  const warned = reviewState([node({ eol: { end: '2029-04-30', days: 120 }, findings: ['Node.js 26 reaches end-of-life on 2029-04-30 (in 120 days). Plan …'] }), tunnel()]);
  assert.deepEqual(reviewState([node({ eol: { end: '2029-04-30', days: 113 }, findings: ['Node.js 26 reaches end-of-life on 2029-04-30 (in 113 days). Plan …'] }), tunnel()], warned), warned);
  const failed = reviewState([node({ eol: null, findings: ['Node.js release schedule unavailable, so end-of-life status is unknown.'] }),
    tunnel({ security: null, advisories: [], findings: ['Advisory lookup failed, so security status is unknown.'] })], base);
  assert.deepEqual(failed, base);
  assert.deepEqual(reviewState([node(), tunnel()], failed), base);
  // Material: a new version, a new advisory, entering the EOL warning, a stable finding.
  for (const changed of [reviewState([node(), tunnel({ latest: 'v0.0.23' })], base),
    reviewState([node(), tunnel({ security: true, advisories: [{ id: 'GHSA-xxxx' }] })], base), warned,
    reviewState([node({ findings: ['CI and the bundled runtime differ: ci.yml uses 26.13.0 (bundled v26.13.1).'] }), tunnel()], base)]) {
    assert.notDeepEqual(changed, base);
    assert.equal(reviewTarget({ action: 'update', number: 362 }, '', base, changed), 362);
  }
  assert.equal(reviewTarget({ action: 'update', number: 362 }, '', base, failed), null);
  assert.equal(reviewTarget({ action: 'update', number: 362 }, '', null, base), 362, 'An issue without stored state is reviewed once');
  assert.equal(reviewTarget({ action: 'create' }, 'https://github.com/YusukeIt0/dot-link/issues/401\n', null, base), 401);
  // A failure-only report is not materially actionable, even when it creates the issue.
  const failureOnly = reviewState([node({ eol: null, findings: ['Node.js release schedule unavailable, so end-of-life status is unknown.'] }),
    tunnel({ outdated: false, latest: 'v0.0.21', security: null, findings: ['Advisory lookup failed, so security status is unknown.'] })]);
  assert.equal(materiallyActionable(failureOnly), false);
  assert.equal(reviewTarget({ action: 'create' }, 'https://github.com/YusukeIt0/dot-link/issues/401', null, failureOnly), null);
  for (const [decision, url] of [[{ action: 'none', number: 362 }], [{ action: 'close', number: 362 }],
    [{ action: 'create' }, ''], [{ action: 'create' }, 'https://github.com/YusukeIt0/dot-link/pull/401']]) {
    assert.equal(reviewTarget(decision, url, null, base), null, JSON.stringify([decision, url]));
  }
  // The state survives in the issue body; malformed or absent state reads as null.
  assert.deepEqual(readReviewState(withReviewState('report\n', base)), base);
  for (const body of ['report', '<!-- dot-link-pinned-runtime-review-state:@@@ -->', undefined]) assert.equal(readReviewState(body), null);
});

test('the watch requests review only from a separate least-privilege job', () => {
  const workflow = readFileSync('.github/workflows/pinned-runtime-watch.yml', 'utf8');
  assert.match(workflow, /review_issue: \$\{\{ steps\.report\.outputs\.review_issue \}\}/);
  const job = workflow.slice(workflow.indexOf('\n  request-review:'));
  assert.match(job, /needs: watch\n\s+if: needs\.watch\.outputs\.review_issue != ''/);
  assert.match(job, /permissions:\n\s+actions: write\n\s+steps:/);
  assert.match(job, /case "\$ISSUE" in ''\|\*\[!0-9\]\*\)/);
  assert.match(job, /gh workflow run claude-review\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f item_number="\$ISSUE"/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\n  request-review:')), /actions: write/);
});

test('only a missing release (404) for the pinned tag widens the advisory window; other failures make it unknown (#368 review)', () => {
  assert.equal(pinnedLookupTransient(new Error('api.github.com request failed: 404')), false);
  for (const message of ['api.github.com request failed: 500', 'api.github.com request failed: 403', 'fetch failed', 'The operation was aborted due to timeout']) {
    assert.equal(pinnedLookupTransient(new Error(message)), true, message);
  }
  // An unknown window is reported like a failed advisory lookup, so the previous review state carries forward.
  const source = sources[0], latest = { tag_name: 'v9.9.9', html_url: 'https://example.invalid' };
  const unknown = releaseStatus(source, 'v1.0.0', latest, null, undefined);
  assert.equal(unknown.security, null);
  const previous = { [source.id]: { security: false, advisories: [] } };
  const state = reviewState([unknown], previous);
  assert.equal(state[source.id].security, false);
  assert.deepEqual(state[source.id].advisories, []);
});

test('assessed advisories are recorded individually and invalid records fail loudly (#443)', () => {
  const real = readAssessments();
  const sparkleAdvisory = real.find(entry => entry.runtime === 'sparkle' && entry.id === 'GHSA-gcjm-h3jh-p2vc');
  assert.equal(sparkleAdvisory?.record, 'https://github.com/YusukeIt0/dot-link/issues/442');
  const entry = { runtime: 'sparkle', id: 'GHSA-gcjm-h3jh-p2vc', decision: 'not-applicable',
    reason: 'Affects only package updates; Dot Link ships app zip updates.', record: 'https://github.com/YusukeIt0/dot-link/issues/442', assessedAt: '2026-11-23' };
  const read = file => () => JSON.stringify(file);
  assert.deepEqual(readAssessments(read({ version: 1, assessed: [entry] })), [entry]);
  assert.deepEqual(readAssessments(read({ version: 1, assessed: [] })), []);
  for (const [file, pattern] of [
    [{ version: 2, assessed: [] }, /must be/],
    [{ version: 1 }, /must be/],
    [{ version: 1, assessed: [], extra: true }, /must be/],
    [{ version: 1, assessed: [{ ...entry, note: 'x' }] }, /exactly/],
    [{ version: 1, assessed: [{ ...entry, reason: undefined }] }, /exactly/],
    [{ version: 1, assessed: [{ ...entry, runtime: 'node' }] }, /unknown runtime/],
    [{ version: 1, assessed: [{ ...entry, id: 'CVE-2026-0001' }] }, /invalid advisory ID/],
    [{ version: 1, assessed: [{ ...entry, decision: 'accepted' }] }, /not-applicable/],
    [{ version: 1, assessed: [{ ...entry, reason: 'n/a' }] }, /reason/],
    [{ version: 1, assessed: [{ ...entry, record: 'https://example.test/442' }] }, /record/],
    [{ version: 1, assessed: [{ ...entry, assessedAt: '2026-13-45' }] }, /assessedAt/],
    [{ version: 1, assessed: [entry, { ...entry }] }, /duplicate/],
  ]) assert.throws(() => readAssessments(read(file)), pattern, JSON.stringify(file));
  assert.equal(assessmentFile, 'config/runtime-advisories.json');
});

test('an assessed advisory is shown but no longer keeps the tracking issue open (#443)', () => {
  const advisory = (id, published_at = '2026-11-17T04:00:24Z') => ({ ghsa_id: id, state: 'published', severity: 'medium', summary: 'Package downgrade', published_at, html_url: `https://example.test/${id}` });
  const assessed = [{ runtime: 'sparkle', id: 'GHSA-2222-3333-4444', decision: 'not-applicable', reason: 'Only package updates are affected.', record: 'https://github.com/YusukeIt0/dot-link/issues/442', assessedAt: '2026-11-23' }];
  const latest = { tag_name: '2.10.1', html_url: 'https://example.test/rel' };
  const quiet = releaseStatus(sparkle, '2.10.1', latest, [advisory('GHSA-2222-3333-4444')], '2026-10-25T14:36:36Z', assessed);
  assert.equal(quiet.security, false);
  assert.deepEqual(quiet.advisories, []);
  assert.deepEqual(quiet.assessed.map(a => [a.id, a.record]), [['GHSA-2222-3333-4444', 'https://github.com/YusukeIt0/dot-link/issues/442']]);
  const quietReport = renderIssue([quiet], '2026-11-30');
  assert.equal(quietReport.actionable, 0);
  assert.match(quietReport.body, /\| Sparkle \| 2\.10\.1 \| 2\.10\.1 \| no \(1 assessed\) \|/);
  assert.deepEqual(decide({ number: 442, body: 'old' }, quietReport), { action: 'close', number: 442 });
  assert.equal(materiallyActionable(reviewState([quiet])), false);
  // The assessment matches one advisory for one runtime: a new advisory, or the same ID on another runtime, still reports.
  const mixed = releaseStatus(sparkle, '2.10.1', latest, [advisory('GHSA-2222-3333-4444'), advisory('GHSA-5555-6666-7777')], '2026-10-25T14:36:36Z', assessed);
  assert.equal(mixed.security, true);
  assert.deepEqual(mixed.advisories.map(a => a.id), ['GHSA-5555-6666-7777']);
  assert.deepEqual(reviewState([mixed]).sparkle.advisories, ['GHSA-5555-6666-7777']);
  const tunnel = sources.find(source => source.id === 'tunnel');
  assert.equal(releaseStatus(tunnel, 'v0.0.21', { tag_name: 'v0.0.21', html_url: 'x' }, [advisory('GHSA-2222-3333-4444')], null, assessed).security, true);
  // A failed lookup stays unknown regardless of assessments.
  assert.equal(releaseStatus(sparkle, '2.10.1', latest, null, null, assessed).security, null);
  // While the issue is open for another reason, the assessed advisory stays visible.
  const open = renderIssue([mixed], '2026-11-30');
  assert.match(open.body, /- Assessed as not applicable: \[GHSA-2222-3333-4444\]\(https:\/\/example\.test\/GHSA-2222-3333-4444\)\. See https:\/\/github\.com\/YusukeIt0\/dot-link\/issues\/442\./);
});

test('an advisory without a newer release asks for an assessment, not a version update (#443)', () => {
  const advisory = { ghsa_id: 'GHSA-2222-3333-4444', state: 'published', severity: 'medium', summary: 'x', published_at: '2026-11-17T00:00:00Z', html_url: 'https://example.test/a' };
  const securityOnly = renderIssue([releaseStatus(sparkle, '2.10.1', { tag_name: '2.10.1', html_url: 'x' }, [advisory], '2026-10-25T00:00:00Z')], '2026-11-23');
  assert.equal(securityOnly.actionable, 1);
  assert.match(securityOnly.body, /Next action: no newer release exists\. Check whether Dot Link uses the affected path\..*config\/runtime-advisories\.json/);
  assert.doesNotMatch(securityOnly.body, /prepare a PR that updates the version/);
  assert.doesNotMatch(securityOnly.body, /Why no automatic PR/);
  const both = renderIssue([releaseStatus(sparkle, '2.10.0', { tag_name: '2.10.1', html_url: 'x' }, [advisory], '2026-06-01T00:00:00Z')], '2026-11-23');
  assert.match(both.body, /Update available: 2\.10\.0 → 2\.10\.1/);
  assert.match(both.body, /Next action: prepare a PR that updates the version/);
  assert.doesNotMatch(both.body, /no newer release exists/);
});
