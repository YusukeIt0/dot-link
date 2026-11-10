import {execFileSync, spawnSync} from 'node:child_process';
import {appendFileSync, existsSync} from 'node:fs';
import {plan} from './ci-plan.mjs';
import {checkDocs} from './check-doc-links.mjs';
import {checkRelease} from './check-release-metadata.mjs';
import {githubReader, reuseContext, verifyReuse} from './ci-reuse.mjs';

const [base, head] = process.argv.slice(2);
const actual = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
if (head && head !== actual) throw new Error('Check out the planned head before validation.');
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], {stdio: ['ignore', 'pipe', 'pipe']});
// Recompute from Git: never trust a hand-edited plan or an output naming fewer tests.
const selected = plan(base, head || actual);
let reused = null;
if (process.env.CI_REUSE_RUN) {
  if (!selected.checks.includes('product')) throw new Error('Reuse is only for full product execution.');
  reused = await verifyReuse(Number(process.env.CI_REUSE_RUN),
    reuseContext({...process.env, CI_HEAD: actual}), githubReader(process.env.GH_TOKEN));
  // Runner may already be Linux. Never silently substitute incomplete native tests.
  if (!reused) throw new Error('Reuse evidence changed or is unavailable. Use GitHub "Re-run all jobs" for full macOS validation; "Re-run failed jobs" retains the old reuse plan and cannot recover it.');
}
const run = (command, args) => {
  const r = spawnSync(command, args, {stdio: 'inherit'});
  if (r.status !== 0) throw new Error(`Validation failed: ${command}`);
};
const tests = (...files) => {
  for (const file of files) if (!existsSync(file)) throw new Error(`Required test is missing: ${file}`);
  run(process.execPath, ['--test', ...files]);
};
console.log(JSON.stringify(selected));
const started = Date.now();
let result = 'failed';
try {
  for (const check of selected.checks) {
    if (check === 'product' && !reused) run('sh', ['scripts/run-ci-tests.sh']);
    if (check === 'docs') {
      checkDocs(selected.paths);
      if (selected.paths.includes('docs/dependencies.md')) tests('tests/dependency-docs.test.mjs');
    }
    if (check === 'site') tests('tests/site.test.mjs', 'tests/site-analytics.test.mjs');
    if (check === 'version' || check === 'feed') await checkRelease(check, selected.base);
  }
  result = 'passed';
} finally {
  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  const summary = `Validation ${result}: ${selected.checks.join(', ')} in ${seconds}s (execution only).`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary}\n`);
  if (reused && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\nProduct execution reused from [run ${reused.run}, attempt ${reused.attempt}](${reused.url}), source ${reused.source}, tree ${reused.tree}. Avoided npm install, product/HTTP tests, build and native suites (${reused.productSeconds}s source execution; not queue time). Current-head workflow, ancestry and review gates remain independent.\n`);
}
