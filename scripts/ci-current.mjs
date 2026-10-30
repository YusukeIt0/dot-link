// Fail closed before expensive work if the triggering PR/ref is no longer current.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {baseIncluded} from './ci-evidence.mjs';
export function currentCI(eventName, event, current, currentBase, comparison) {
  if (eventName === 'pull_request') {
    const expected = event.pull_request;
    return current.state === 'open' && current.number === expected?.number &&
      current.head?.sha === expected.head?.sha && current.head?.repo?.full_name === expected.head?.repo?.full_name &&
      /^[a-f0-9]{40}$/.test(currentBase || '') && baseIncluded({base: currentBase}, comparison);
  }
  return eventName === 'push' && /^[a-f0-9]{40}$/.test(event.after || '') && current.object?.sha === event.after;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env, event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw new Error('Invalid repository');
  let path;
  if (env.GITHUB_EVENT_NAME === 'pull_request' && Number.isSafeInteger(event.pull_request?.number)) path = `pulls/${event.pull_request.number}`;
  else if (env.GITHUB_EVENT_NAME === 'push' && event.ref?.startsWith('refs/heads/')) path = `git/ref/heads/${encodeURIComponent(event.ref.slice(11))}`;
  else throw new Error('Unsupported CI event');
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
    headers: {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(15_000)});
  if (!response.ok) throw new Error('Cannot verify current CI context.');
  const current = await response.json();
  let currentBase, comparison;
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    // pulls/{n}.base.sha may lag a branch push. Resolve the current ref directly.
    const baseResponse = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/${encodeURIComponent(current.base?.ref || '')}`, {
      headers: {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(15_000)});
    if (!baseResponse.ok) throw new Error('Cannot verify current base ref.');
    currentBase = (await baseResponse.json()).object?.sha;
    if (!/^[a-f0-9]{40}$/.test(currentBase || '') || !/^[a-f0-9]{40}$/.test(current.head?.sha || '')) throw new Error('Invalid CI revisions.');
    const comparisonResponse = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/compare/${currentBase}...${current.head.sha}`, {
      headers: {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(15_000)});
    if (!comparisonResponse.ok) throw new Error('Cannot verify current base ancestry.');
    comparison = await comparisonResponse.json();
    if (execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim() !== event.pull_request.head.sha) {
      throw new Error('PR validation must check out the exact PR head, not a synthetic merge revision.');
    }
  }
  if (!currentCI(env.GITHUB_EVENT_NAME, event, current, currentBase, comparison)) throw new Error('CI context is superseded or the current base is not included; update the PR head from its current base to trigger fresh validation.');
}
