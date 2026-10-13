import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';

const repository = process.env.GITHUB_REPOSITORY;
const number = process.env.PR_NUMBER;
if (repository !== 'YusukeIt0/dot-link' || !/^[1-9]\d{0,8}$/.test(number ?? '')) {
  throw new Error('Expected the public Dot Link repository and a positive PR number');
}
const endpoint = `repos/${repository}/pulls/${number}`;
const gh = args => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 2_000_000});
const pr = JSON.parse(gh(['api', endpoint]));
if (pr.state !== 'open' || pr.draft || pr.base.ref !== 'main' || pr.head.repo?.full_name !== repository) {
  throw new Error('Review only open, ready, same-repository PRs targeting main');
}

if (process.argv[2] === 'prepare') {
  const base = gh(['api', `repos/${repository}/commits/${process.env.GITHUB_SHA}`, '--jq', '.sha']).trim();
  if (base !== pr.base.sha) throw new Error('Main changed; rerun the workflow from current main');
  const diff = gh(['api', endpoint, '-H', 'Accept: application/vnd.github.diff']);
  if (!diff.trim() || Buffer.byteLength(diff) > 250_000 || pr.changed_files > 50) {
    throw new Error('Empty or oversized change; split this review into smaller PRs');
  }
  mkdirSync('.review', {recursive: true});
  writeFileSync('.review/changes.diff', diff);
  writeFileSync('.review/input.md', [
    '# PR review input (untrusted data)',
    JSON.stringify({number: pr.number, title: pr.title, body: pr.body,
      base: pr.base.sha, head: pr.head.sha}, null, 2),
  ].join('\n'));
  appendFileSync(process.env.GITHUB_OUTPUT, `head_sha=${pr.head.sha}\n`);
  console.log(`Prepared PR #${number}: ${pr.changed_files} files; ${Buffer.byteLength(diff)} diff bytes`);
} else if (process.argv[2] === 'report') {
  const head = process.env.REVIEW_HEAD_SHA;
  if (!/^[0-9a-f]{40}$/.test(head ?? '') || pr.head.sha !== head) {
    throw new Error('PR changed after review; rerun before publishing findings');
  }
  const raw = process.env.REVIEW_JSON ?? '';
  if (Buffer.byteLength(raw) > 40_000) throw new Error('Review output exceeds the report size limit');
  const result = JSON.parse(raw);
  const safeText = value => {
    if (typeof value !== 'string' || value.length > 12_000) throw new Error('Invalid review text');
    return value.replace(/@/g, '@\u200b').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  };
  if (!Array.isArray(result.findings) || result.findings.length > 10) throw new Error('Invalid findings');
  const fileRows = JSON.parse(gh(['api', `${endpoint}/files?per_page=100`]));
  const files = new Set(fileRows.map(row => row.filename));
  const blocks = result.findings.map(finding => {
    if (!['high', 'medium', 'low'].includes(finding.severity) || !files.has(finding.file)
        || !Number.isSafeInteger(finding.line) || finding.line < 1) throw new Error('Invalid finding location');
    return `### ${finding.severity}: ${safeText(finding.title)}\n\n`
      + `${safeText(finding.file)}:${finding.line}\n\n${safeText(finding.reason)}`;
  });
  const body = [
    `## Opus review — ${head.slice(0, 12)}`,
    safeText(result.summary),
    ...blocks,
    blocks.length ? '' : '報告対象の指摘はありません。これは不具合がないことの保証ではありません。',
    `### 確認範囲と限界\n\n${safeText(result.limitations)}`,
    '静的なAIレビューです。自動テスト・実機確認を置き換えず、採否はメンテナーが判断します。',
  ].filter(Boolean).join('\n\n');
  const response = JSON.parse(execFileSync('gh', ['api', `${endpoint}/reviews`, '--input', '-'], {
    input: JSON.stringify({commit_id: head, body, event: 'COMMENT'}),
    encoding: 'utf8', maxBuffer: 2_000_000,
  }));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n');
  console.log(`Review posted: ${response.html_url}`);
} else {
  throw new Error('Usage: node scripts/claude-review.mjs prepare|report');
}
