# Automatic merging — staged and disabled

This is a design and testable implementation, not activation. Existing explicit
maintainer main-merge instructions remain in force. The PR introducing these
controls is itself excluded. Distribution, releases, review submission and
publication remain separate decisions.

## Decision

`node scripts/auto-merge.mjs --dry-run [PR-number]` is read-only. It checks:

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
- No technical findings, changes-requested review, missing evidence, unverified
  requirement, stale scope, or unresolved product decision. Runtime-affecting
  paths require applicable physical evidence independently of model wording.
- An independently assessed current acceptance record. Non-blocking architecture
  advice is not a defect and does not veto merging by itself.

The coordinator reads everything again immediately before an exact-head squash
merge and requires both snapshots to match. It merges at most one PR per run;
other PRs must be reviewed/tested against the resulting main. It does not queue
GitHub native auto-merge on the basis of an old green snapshot. See
[`development-policy.json`](../config/development-policy.json) for the bounded policy.

GitHub provides an exact-head `sha` guard and branch-protection enforcement, not
an atomic transaction across main, issue comments, scope and evidence. A change
after the last API read remains a residual race; this is not claimed to be zero
risk. Serializing coordinator runs does not serialize human edits or other merges.
Before activation, decide whether this bounded risk is acceptable for the allowed
change class; stricter governance would need an additional server-side mechanism.

## Credentials and inactive live validation

The assessor needs to read branch protection, which requires Administration read
for an App token. The default `GITHUB_TOKEN` cannot supply that permission. Use a
dedicated App, installed only on this repository, instead of expanding the model
reviewer's App. The merge App needs Administration read, Actions read, Contents
write, Issues read, Pull requests write and Variables read. It must not have a
branch-protection bypass. Its assessor token is downscoped to read-only Contents
and Pull requests; only the separately gated merge job mints write permissions.

Store its client ID in `DOTLINK_MERGE_CLIENT_ID` and private key only in
`DOTLINK_MERGE_PRIVATE_KEY`. No App or secret is created by this work. Without the
App the workflow explicitly reports that dry-run validation is blocked; that
summary is not evidence of a passing assessment. Dedicated App events can trigger
subsequent normal workflows, unlike many writes made using `GITHUB_TOKEN`.

After a separately authorized merge of this control-plane PR:

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
