// A metadata check verifies existing full Tests evidence; it never certifies itself.
import {readFileSync, appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {ciRepository, ciMetadataReceipt, ciTarget, collectCI} from './ci-evidence.mjs';
import {currentCI} from './ci-current.mjs';

export async function verifyMetadataCI({event, readCurrent, collect, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 18 * 60_000}) {
  if (event.action !== 'edited' || event.changes?.base != null || !event.pull_request) {
    throw new Error('Only a metadata-only PR edit can reuse validation.');
  }
  const deadline = now() + timeoutMs;
  const current = () => {
    const {pr, base} = readCurrent();
    if (!currentCI('pull_request', event, pr, base.sha)) throw new Error('Metadata check context is stale.');
    return {pr, base};
  };
  while (true) {
    const {pr, base} = current();
    const evidence = collect(pr, base);
    if (evidence.status === 'ready') {
      const fresh = current();
      const again = collect(fresh.pr, fresh.base);
      if (again.status === 'ready' && again.run.id === evidence.run.id &&
          again.run.run_attempt === evidence.run.run_attempt) {
        current();
        return {id: again.run.id, attempt: again.run.run_attempt};
      }
      throw new Error('Full validation changed while verifying metadata.');
    }
    if (evidence.run?.status === 'completed') throw new Error(evidence.reason);
    if (now() >= deadline) throw new Error('No complete current full Tests evidence within the bounded wait.');
    await sleep(Math.min(15_000, deadline - now()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  if (env.GITHUB_REPOSITORY !== ciRepository || env.GITHUB_EVENT_NAME !== 'pull_request' ||
      !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '')) throw new Error('Invalid metadata check context.');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const gh = args => JSON.parse(execFileSync('gh', args, {encoding: 'utf8', timeout: 30_000, maxBuffer: 10_000_000}));
  const api = path => gh(['api', `repos/${ciRepository}/${path}`]);
  const pages = path => gh(['api', `repos/${ciRepository}/${path}`, '--paginate', '--slurp']);
  const target = ciTarget(event.pull_request);
  const own = api(`actions/runs/${env.GITHUB_RUN_ID}`);
  if (own.display_title !== ciMetadataReceipt(target)) throw new Error('Metadata receipt does not match dispatch context.');
  const result = await verifyMetadataCI({event, readCurrent: () => {
    const pr = api(`pulls/${target.number}`);
    const base = {ref: pr.base.ref, sha: api(`git/ref/heads/${encodeURIComponent(pr.base.ref)}`).object?.sha};
    return {pr, base};
  }, collect: (pr, base) => collectCI(pr, base, api, pages)});
  const summary = `Metadata-only check: verified full Tests run https://github.com/${ciRepository}/actions/runs/${result.id}/attempts/${result.attempt}. No product tests were rerun here.\n`;
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
}
