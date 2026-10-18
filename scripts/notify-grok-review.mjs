// Best-effort wake-up only. Never read review content or alter the merge hold.
export async function notifyGrokReview({repo, pr, head_sha}, {
  env = process.env, fetchImpl = globalThis.fetch,
  warn = message => console.warn(`::warning::${message}`),
} = {}) {
  const url = env.GROK_REVIEW_WEBHOOK_URL, key = env.GROK_REVIEW_WEBHOOK_KEY;
  if (!url || !key) {
    warn('Grok notification skipped: webhook secrets are not configured. Review hold retained.');
    return;
  }
  try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Invalid endpoint');
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: {'Content-Type': 'application/json', Authorization: key},
      body: JSON.stringify({repo, pr, head_sha}),
    });
    // Do not log the URL, headers, response body or transport errors: they may contain secrets.
    if (!response.ok) warn('Grok notification failed: non-success response. Review hold retained.');
    await response.body?.cancel();
  } catch {
    warn('Grok notification failed: request could not complete. Review hold retained.');
  }
}
