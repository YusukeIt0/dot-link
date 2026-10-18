# Automatic merging

The repository's automatic merge policy was activated on 2026-10-18. The live
`DOTLINK_AUTO_MERGE_ENABLED` variable remains authoritative; removing it disables
new automatic mutations. Eligible product/documentation PRs can merge after all
existing gates pass. Protected control-plane changes, including this coordinator,
still require an explicit maintainer merge decision. Distribution, releases,
review submission and publication remain separate decisions.

## Decision

`node scripts/auto-merge.mjs --dry-run [priority-PR-number]` is read-only.
Every automatic or manual execution enumerates all open, non-draft, trusted-author
PRs targeting main. A supplied PR number only moves that candidate to the front;
it never narrows the scan. Missing, invalid or closed priority hints do not prevent
other candidates from being checked. Remaining candidates are checked oldest PR
number first. More than 20 candidates, or an incomplete enumeration, fails closed
and requires backlog intervention; a priority hint does not bypass that bound.
It checks:

- An open, non-draft PR from the configured numeric user ID and matching login,
  from this repository and targeting main. The initial allowlist contains only
  repository owner `YusukeIt0` (213780070), not every collaborator.
- No protected or unknown paths, including rename origins. Workflows, scripts,
  configuration, assurance documentation and gate tests require a human merge
  decision after technical verification. Dependency/build configuration is
  excluded; package/app JSON is permitted only for strictly version-only changes.
- Current main is contained in the head; branch protection has not fallen below
  the observed strict required-test/admin/no-force/no-delete baseline.
- The latest associated exact-head CI run and all required jobs succeeded.
  Skipped, pending, missing or failed jobs never count as passes.
- A verified Dotsweeper receipt for current head/main, description, discussion,
  inline/formal review and agreed scope; all intake/review/report jobs succeeded.
  GraphQL last-editor metadata authenticates the current comment revision; original
  authorship alone is insufficient after another repository writer edits it.
- No technical findings, changes-requested review, missing evidence, unverified
  requirement, stale scope, or unresolved product decision. Runtime-affecting
  paths require applicable physical evidence independently of model wording.
- An independently assessed current acceptance record. Non-blocking architecture
  advice is not a defect and does not veto merging by itself.

The coordinator reads everything again immediately before an exact-head squash
merge and requires both snapshots to match. JSON object keys are sorted recursively
before comparison: GitHub can change their serialization order without changing
any input values. No evidence fields are excluded, and array order is preserved.
It attempts at most one merge request per execution. After a confirmed merge,
it re-enumerates the remaining PRs and performs a read-only scan against current
main, including candidates examined before the merge. Main must include the
confirmed merge commit. Other PRs must be reviewed/tested against the resulting
main; normal CI/review completion events request their next assessment. It does not queue
GitHub native auto-merge on the basis of an old green snapshot. See
[`development-policy.json`](../config/development-policy.json) for the bounded policy.

GitHub provides an exact-head `sha` guard and branch-protection enforcement, not
an atomic transaction across main, issue comments, scope and evidence. A change
after the last API read remains a residual race; this is not claimed to be zero
risk. Serializing coordinator runs does not serialize human edits or other merges.
The conservative full-snapshot equality check can also hold a PR after unrelated
repository metadata changes. That is a safe false hold, not evidence that the PR
is defective. When the final snapshot is still eligible but differs, execution
waits 30 seconds and then 60 seconds before up to two fresh attempts (three total).
All candidates share a 90-second wait budget per run, limiting additional attempts
to at most three across the run. Once the remaining budget cannot cover the next
delay, that PR stays held for a later run; other candidates still receive their
initial assessment. This bounds added retry work within the existing 10-minute job
limit, but does not guarantee completion if GitHub API reads themselves are slow.
Each attempt rechecks activation and collects and evaluates both snapshots again;
no previous eligible decision is reused. Persistent churn remains held. Other
blockers and merge API errors are not automatically retried. Logs identify changed
top-level input categories without publishing their contents. Full input values
are still compared; retrying never waives a gate.

## Latest pending request and failure recovery

Relevant events share the fixed repository-wide concurrency group
`dot-link-automatic-merge`, with `queue: single` and `cancel-in-progress: false`.
One run executes and at most one waits. New arrivals replace only the pending run;
the active coordinator and any mutation continue. A cancelled pending run is a
superseded request, not a successful assessment. Every retained request scans all
candidates, so a final manual priority request still covers other PRs.
Non-main manual dispatches and non-PR comment events use isolated ignored groups
and skip assessment: they cannot replace a valid pending full scan. The YAML
checker enforces that admission to the shared group matches assessor admission.

The assessor and executor share **one immediate failure-recovery allowance** per
workflow execution. The assessor exports whether it used that allowance; the
executor consumes the same value. Transient API/network failures restart a fresh
full scan once in the same process. There is no recursive workflow dispatch,
periodic schedule, or additional write permission. Both attempts and the original
failure remain in logs/summary; an unrecovered failure exits nonzero. A per-PR
error is recorded while the scan continues to the other candidates. After the
scan, any such error fails that attempt and may consume the remaining recovery
allowance. Permanent errors do not trigger recovery. A completed read-only scan
exports completion even when individual PRs failed: the executor can then
independently recheck and merge a healthy candidate, while the failed assessor
keeps the overall workflow failed. Global enumeration/main failures, incomplete
scans, setup failures and cancellation do not authorize that continuation. Missing App
setup also fails rather than reporting a successful assessment.

Valid holds (pending/failed CI, missing/stale review, invalid acceptance, revoked
scope, protection or other eligibility failures) do not consume the recovery
allowance. Authentication/permission failures and configuration errors fail
without retry. The existing 30/60-second snapshot-churn rechecks are distinct;
their 90-second budget remains shared across candidates and recovery passes in
the execution job. Recovery never resets a gate or reuses a prior green decision.

Once a merge request is attempted, all subsequent work in that execution is
read-only, even if the response is lost. Read-back checks the PR's merged state,
head and merge commit. An unconfirmed result remains a failed outcome, never a
reason to resend the merge or merge another PR. An explicit rejection (HTTP 4xx
or `merged: false`) is recorded as rejected, not ambiguous, and does not spend
the recovery allowance. Other candidates are still inspected read-only. A post-merge read failure can
spend the remaining recovery allowance, but cannot authorize another mutation.

If a request is rejected before a job starts, setup/runner termination prevents
the script from running, or recovery also fails, the next relevant event or a
manual **Run workflow** on main performs a fresh full scan. An optional PR number
is only a priority hint. There is no guaranteed autonomous recovery if no later
event arrives; no periodic fallback is installed. An ongoing outage may require
manual intervention. Manually starting a new execution does not waive current
activation or evidence requirements.

The concurrency bound concerns pending workflow runs, not API cost or latency.
Each full scan still reads per-PR evidence. GitHub scheduling/API delays and the
20-candidate limit remain. Tests cover transient and repeated failures, final
state after a burst, manual priority, stale evidence, new main, ambiguous mutation
responses, recovery-budget sharing and later manual recovery. Use a small,
isolated, credential-free live burst to verify GitHub queue behavior; do not fill
the production queue or cancel an active merger for testing.

Pinned upstream actionlint 1.7.12 does not recognize `concurrency.queue` yet.
Workflow lint suppresses only that exact unsupported-key diagnostic and separately
parses the YAML to require the complete concurrency policy above, rejecting queue
usage elsewhere. Its regression tests and all other actionlint/zizmor checks remain
required. Remove the diagnostic exception and compatibility check when the pinned
upstream actionlint supports queue; do not broaden the exception or switch forks.
The existing activation decision covers the allowed change class; stricter governance would need an additional server-side mechanism.

## Credentials and activation

The assessor needs to read branch protection, which requires Administration read
for an App token. The default `GITHUB_TOKEN` cannot supply that permission. Use a
dedicated App, installed only on this repository, instead of expanding the model
reviewer's App. The `dotsweeper-merge` installation is limited to `dot-link` and has no
branch-protection bypass. The assessor requests only read access to Administration,
Actions, Checks, Commit statuses, Contents, Issues, Pull requests and Actions
variables (plus mandatory Metadata). The separately activated execution job
requests Contents write for the merge endpoint. Pull requests remains read-only.
This scheduling change adds no permission or activation scope.

Store its client ID in `DOTLINK_MERGE_CLIENT_ID` and private key only in
`DOTLINK_MERGE_PRIVATE_KEY`. Without the App the workflow explicitly reports that
dry-run validation is blocked; that summary is not evidence of a passing assessment.
Dedicated App events can trigger subsequent normal workflows, unlike many writes
made using `GITHUB_TOKEN`.

GitHub's installation-token API calls the variables permission `actions_variables`.
The pinned `actions/create-github-app-token` version does not declare that input in
its metadata, but its [permission parser](https://github.com/actions/create-github-app-token/blob/64ab729a6294000f5aa4a4bc0b73d1f32bc45510/lib/get-permissions-from-inputs.js)
reads `INPUT_PERMISSION-*` environment entries and converts hyphens to underscores.
Both token steps therefore pass `INPUT_PERMISSION-ACTIONS-VARIABLES: read` through
`env`, alongside explicit supported permission inputs. Do not use the invalid
`permission-variables`, or omit all permissions and inherit the App's future grants.
Keep the action pinned and its default post-job token revocation enabled. Recheck
this compatibility mapping when upgrading the action; replace it with a declared
input once upstream supports one.

For a new installation, validate before activating:

1. Configure the dedicated App under separate authorization, leaving activation
   unset. Run the new Dotsweeper prompt and inactive assessor on a bounded PR.
2. Confirm permission access, structured assessment publication, exact-head CI
   selection and expected held/eligible decisions with no merge mutation.
3. Test stale/missing evidence and scope changes, protected files, outsiders,
   failed/skipped/in-progress jobs and changed main; confirm withheld decisions.
4. Confirm App permission boundaries and the separate downstream workflow path
   before allowing unattended operation. Tests using fake clients are not this proof.
5. Present live evidence, residual races and operating impact for the explicit
   activation decision. Do not equate main merge approval with activation.

Only after that decision set `DOTLINK_AUTO_MERGE_ENABLED=reviewed-policy-v1`.
Both the trusted-main workflow identity and freshly read variable are required by
the execution script. Remove the variable to stop new executions; also cancel
any executing merge job when an immediate stop is required. A merge already
accepted by GitHub cannot be cancelled by changing a variable.

References: [branch-protection API permissions](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection),
[merge API and exact-head parameter](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request),
[workflow triggering from tokens](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow).
