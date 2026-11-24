// Maintainer only: submits a Developer ID signed app for Apple notarization,
// staples the ticket and checks Gatekeeper. Credentials come from a notarytool
// keychain profile; nothing is read from or written to the repository.
import {mkdir, readFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {developerIDProblems, developerTeam} from './lib/mac-signing.mjs';

const app = resolve(process.argv[2] ?? '.runtime/mac-app/Dot Link.app');
const profile = process.env.DOTLINK_NOTARY_PROFILE?.trim();
const keychain = process.env.DOTLINK_SIGNING_KEYCHAIN?.trim();
if (!profile) throw new Error('Set DOTLINK_NOTARY_PROFILE to a notarytool keychain profile name');
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, {encoding: 'utf8', maxBuffer: 10e6});
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${cmd} ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(-2000)}`);
  return result;
};
const team = developerTeam(JSON.parse(await readFile('config/mac-update.json', 'utf8')));
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const problems = developerIDProblems(run('/usr/bin/codesign', ['-dvv', app]).stderr, team);
if (problems.length) throw new Error('Not ready for notarization: ' + problems.join('; '));

const credentials = ['--keychain-profile', profile, ...(keychain ? ['--keychain', keychain] : [])];
const directory = resolve('.runtime/notarization');
await mkdir(directory, {recursive: true});
const archive = join(directory, `submission-${process.pid}.zip`);
try {
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
  const submitted = run('/usr/bin/xcrun', ['notarytool', 'submit', archive, ...credentials, '--wait', '--timeout', '1h', '--output-format', 'json'], {allowFailure: true});
  let result;
  try { result = JSON.parse(submitted.stdout); } catch { throw new Error('notarytool submit failed: ' + (submitted.stderr || submitted.stdout).trim().slice(-2000)); }
  if (result.status !== 'Accepted') {
    const log = result.id ? run('/usr/bin/xcrun', ['notarytool', 'log', result.id, ...credentials], {allowFailure: true}).stdout : '';
    throw new Error(`Notarization ${result.status ?? 'failed'} (${result.id ?? 'no submission id'})\n${log.slice(0, 8000)}`);
  }
  run('/usr/bin/xcrun', ['stapler', 'staple', app]);
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  const assessment = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  if (!/source=Notarized Developer ID/.test(assessment.stderr)) throw new Error('Gatekeeper did not report a notarized Developer ID app: ' + assessment.stderr.trim());
  console.log(JSON.stringify({app, submission: result.id, status: result.status, stapled: true, gatekeeper: 'Notarized Developer ID'}));
} finally {
  await rm(archive, {force: true});
}
