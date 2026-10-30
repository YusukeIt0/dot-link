// Read-only branch preflight. API uncertainty retains validation, never green evidence.
import {appendFileSync, readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function matchingOpenPR(rows, repository, ref, head) {
  return rows.some(p => p.state === 'open' && p.head?.repo?.full_name === repository &&
    p.head?.ref === ref && p.head?.sha === head);
}
export async function branchAdmission({repository, ref, head}, get) {
  try {
    const current = await get(`git/ref/heads/${encodeURIComponent(ref)}`);
    if (!/^[a-f0-9]{40}$/.test(current.object?.sha || '')) throw new Error('Invalid ref response');
    if (current.object.sha !== head) return {run: false, reason: 'Superseded branch revision.'};
    for (let page = 1; page <= 10; page++) {
      const rows = await get(`pulls?state=open&head=${encodeURIComponent(repository.split('/')[0] + ':' + ref)}&per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('Invalid PR response');
      if (matchingOpenPR(rows, repository, ref, head)) return {run: false, reason: 'Open PR owns validation for this head.'};
      if (rows.length < 100) return {run: true, reason: 'No matching open PR; validate branch.'};
    }
    throw new Error('Incomplete PR enumeration');
  } catch {
    return {run: true, reason: 'PR/ref lookup unavailable; retain branch validation.'};
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env, event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || env.GITHUB_EVENT_NAME !== 'push' ||
      !event.ref?.startsWith('refs/heads/') || !/^[a-f0-9]{40}$/.test(event.after || '')) throw new Error('Invalid branch context');
  const result = await branchAdmission({repository, ref: event.ref.slice(11), head: event.after}, async path => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw new Error('Read failed');
    return response.json();
  });
  appendFileSync(env.GITHUB_OUTPUT, `run=${result.run}\n`);
  appendFileSync(env.GITHUB_STEP_SUMMARY, `Branch validation: ${result.reason}\n`);
}
