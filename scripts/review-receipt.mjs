// Shared authenticated PR receipt and workflow checks; no GitHub mutations.
const repository = 'YusukeIt0/dot-link';
const marker = '<!-- dot-link-opus-review:v1 -->';

export function latestReceipt(comments, botId) {
  const row = comments.filter(x => String(x.user?.id) === String(botId) &&
    x.user?.login === 'dotsweeper[bot]' && x.user?.type === 'Bot' && x.body?.startsWith(marker)).at(-1);
  if (!row) throw new Error('No verified dotsweeper comment.');
  if (!row.revision_verified || row.revision_author?.type !== 'Bot' ||
      row.revision_author.login !== 'dotsweeper[bot]' || String(row.revision_author.id) !== String(botId)) {
    throw new Error('Current review comment revision is not authenticated to dotsweeper.');
  }
  const match = row.body.match(/^<!-- dot-link-opus-review:v1 -->\n<!-- dot-link-review-owner:([1-9]\d*):([1-9]\d*) -->\n## dotsweeper review · Complete\n\n<!-- dot-link-review-input:head=([a-f0-9]{40});main=([a-f0-9]{40});input=([a-f0-9]{64}) -->/);
  if (!match) throw new Error('Latest review is incomplete, outdated, failed, or predates revision receipts.');
  const baseMatch = row.body.slice(match[0].length).match(/^\n\n<!-- dot-link-review-base:ref=([^;\s]+);sha=([a-f0-9]{40}) -->/);
  const base = baseMatch ? {ref: decodeURIComponent(baseMatch[1]), sha: baseMatch[2]} : undefined;
  const qualityMatch = row.body.slice(match[0].length + (baseMatch?.[0].length || 0)).match(/^\n\n<!-- dot-link-review-quality:([A-Za-z0-9_-]+) -->/);
  let quality;
  if (qualityMatch) {
    if (qualityMatch[1].length > 80_000) throw new Error('Oversized review quality receipt.');
    quality = JSON.parse(Buffer.from(qualityMatch[1], 'base64url').toString('utf8'));
  }
  return {base, quality, runId: match[1], intakeAttempt: Number(match[2]), head: match[3], main: match[4], fingerprint: match[5], commentId: row.id};
}

export function assertReviewRun(receipt, run, jobs) {
  if (String(run.id) !== receipt.runId || run.path !== '.github/workflows/claude-review.yml' ||
      run.repository?.full_name !== repository || run.status !== 'completed' || run.conclusion !== 'success' ||
      run.run_attempt < receipt.intakeAttempt) throw new Error('The owning review workflow has not completed successfully.');
  for (const name of ['intake', 'review', 'report']) {
    const matches = jobs.filter(x => x.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      throw new Error(`Review job is not successfully complete: ${name}`);
    }
  }
}
