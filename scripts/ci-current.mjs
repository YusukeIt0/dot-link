// Fail closed before expensive work if the triggering PR/ref is no longer current.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function currentCI(eventName, event, current) {
  if (eventName === 'pull_request') {
    const expected = event.pull_request;
    return current.state === 'open' && current.number === expected?.number &&
      current.head?.sha === expected.head?.sha && current.head?.repo?.full_name === expected.head?.repo?.full_name &&
      current.base?.ref === expected.base?.ref && current.base?.sha === expected.base?.sha;
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
  if (!currentCI(env.GITHUB_EVENT_NAME, event, await response.json())) throw new Error('CI context is superseded; validate the current head/base.');
}
