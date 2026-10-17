# Development process audit — 2026-10-17

Scope: [#73](https://github.com/YusukeIt0/dot-link/issues/73), baseline
[`a011736`](https://github.com/YusukeIt0/dot-link/tree/a0117365ac8d3594c0fc462d5e3ebbc38e1abd29).
The outcome is earlier defect detection, reliable behavior evidence, focused design
review and less avoidable human work, including a prepared but disabled automatic
merge path. No application behavior or branch policy is changed by this audit.

## Evidence and six-part assessment

The [API snapshot](evidence/development-baseline.json) contains 250 recent Actions
runs, main branch protection and repository rulesets. It is a bounded sample,
not the repository's complete history. Reproduce with `gh run list --limit 250
--json conclusion,createdAt,databaseId,event,headSha,updatedAt,workflowName`,
`gh api repos/YusukeIt0/dot-link/branches/main/protection`, and
`gh api repos/YusukeIt0/dot-link/rulesets`.

| Question | Verified baseline and implication |
| --- | --- |
| What already works? | CI runs unit/HTTP/native tests and TypeScript/build checks. Dotsweeper separates intake, a read-only model job and publication. Review receipts pin head/main/discussion and child base; the manual gate checks the owning workflow's three jobs. Triage preserves human label choices. See baseline [CI](https://github.com/YusukeIt0/dot-link/blob/a0117365ac8d3594c0fc462d5e3ebbc38e1abd29/.github/workflows/ci.yml), [review](https://github.com/YusukeIt0/dot-link/blob/a0117365ac8d3594c0fc462d5e3ebbc38e1abd29/scripts/claude-review.mjs), [gate](https://github.com/YusukeIt0/dot-link/blob/a0117365ac8d3594c0fc462d5e3ebbc38e1abd29/scripts/check-review-before-merge.mjs). |
| What is not established? | No machine-checked mapping of agreed requirements to applicable evidence; a successful static review cannot establish physical UX. No measured precision/recall for model review. No live automatic-merge path. |
| What is an observed bottleneck/problem? | Review wall time is short enough that a differential-cache redesign has no demonstrated benefit. Unpinned CI/site action references and persisted checkout credentials are verified hardening gaps, not observed exploits. The manual gate is advisory and does not itself decide findings or acceptance. |
| Where can improvement help? | Fast workflow lint, pinned actions, explicit evidence assessment, stale scope/inline-feedback detection, bounded issue relationships, automatic trusted-author re-review, and a separately disabled coordinator remove identifiable gaps. |
| What should remain? | Full diff plus main/parent context; existing TypeScript checks; Dotsweeper as the base reviewer; human product decisions; issue labels without a second backlog; current branch policy pending a decision. Do not add routine speculative refactors or a permanent extra reviewer without evidence. |
| What is missing for safe automatic merging? | Explicit trusted identities, protected-change exclusions, current agreed scope and evidence, complete exact-head CI/review, final rechecks, credential separation, live inactive validation, and separate activation authorization. This PR implements the staged checks; it cannot establish the last two by unit tests. |

## Actions timing and protection

The sample spans 2026-10-14 05:10:49 through 2026-10-16 09:33:40 UTC.
Elapsed time is `updatedAt - createdAt`, including queues and finalization; it is
not model inference time. Rounded whole-second values:

| Workflow | Sample outcomes | Successful elapsed median / p90 / max |
| --- | --- | --- |
| Tests | 100 success, 2 failure | 78 / 90 / 109 s |
| dotsweeper review | 55 success, 85 skipped, 2 cancelled | 127 / 195 / 227 s |
| Site | 6 success | 20 s median |

Workflow success can include an outdated/skipped report; it does not mean a clean
current review. The two failed test runs
([38747526086](https://github.com/YusukeIt0/dot-link/actions/runs/38747526086),
[38747635844](https://github.com/YusukeIt0/dot-link/actions/runs/38747635844))
both report TS1375 in `tests/wake-custom-runtime.test.ts`. Existing TypeScript
checking caught the missing module declaration. These are not evidence that a
new TypeScript linter would have prevented additional defects.

In [review run 38880583030](https://github.com/YusukeIt0/dot-link/actions/runs/38880583030),
the queue before intake was about 40 s; intake 9 s, review job 83 s, model step
71 s and publication 15 s. In [test run 38880585140](https://github.com/YusukeIt0/dot-link/actions/runs/38880585140),
the test job was 56 s, unit tests 35 s, build 1 s and native tests 7 s.
Keep full-context re-review: a complex cache would add invalidation risk without
a demonstrated end-to-end improvement. Trusted-author pushes now request review
automatically; ordinary comments still do not start a model run.

API-confirmed protection: `test` required from GitHub Actions app 15368,
strict up-to-date checks, administrator enforcement on, force pushes/deletions
off. Required approvals are 0; stale-approval dismissal, last-push approval and
conversation-resolution requirements are off. Repository rulesets are empty.
Native repository auto-merge is disabled. Only the two existing Dotsweeper
variables were present; no dedicated merge App ID or activation variable was
configured. No setting was changed. An individual-owned repository does not
support the organization merge-queue option; changing ownership is not proposed.

## Tool trials and technical decisions

| Candidate | Verified result | Decision and practical effect |
| --- | --- | --- |
| actionlint 1.7.12 | No finding on baseline workflows. | Adopt the fast workflow syntax/expression check; complements application tests. Download is checksum-pinned. |
| zizmor 1.31.1 | Baseline: 11 findings, comprising 7 action pinning, 2 checkout credential persistence, 2 broad trigger warnings. | Pin action commits and disable credential persistence. Keep deliberate read-only/trusted-helper trigger architecture with narrow inline exceptions. Warnings are not proof of an exploit. |
| oxlint 1.88.0 | 32 warnings, mostly stylistic/unused expressions. `server/stt.ts` uses intentional reject/resolve ternaries; the `src/main.ts` finally guard protects an obsolete session. No independently verified product defect from this trial. | Do not add a blanket mandatory lint or unrelated product cleanup. Type-aware mode was not evaluated. Existing type checks remain. |

For the credential/pinning findings: the possible consequence is that a mutable
external action changes without a repository diff, or checkout credentials remain
available to subsequent code. This is a verified configuration fact; exploitation
was not observed. Pinning and disabling persistence reduce that exposure without
changing app UX. No product choice is needed. Future action updates require an
explicit SHA update and the usual review.

Evidence gaps have a different consequence: a green review could be mistaken for
verified device behavior. That is a workflow limitation, not proof of a broken
app. The new assessment separates tests, static inspection, runtime observations,
physical observations and unknowns. It asks for actual operations and outcomes
only when device behavior is affected. Product choices remain with the maintainer;
agents prepare the evidence records from already agreed scope and observations.

## Branch policy proposal — not adopted

Proposed direction: ordinary main-target PRs for independently useful complete
changes; bottom-up stacked PRs for real dependencies; an integration branch only
when the full experience cannot safely land in independent parts. References:
[GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow) and
[stack merging](https://graphite.com/docs/merge-stack-prs-github).
The maintainer has not approved this policy change. Existing branch instructions
and their documentation are intentionally not rewritten. The audit found stale
wording about child review in `docs/ai-review.md`; actual child support already
exists in code. Reconcile those branch-specific passages with the policy decision.

## Independent-review comparison and validation

The initial comparison used frozen commit `3e8efcb1d6803e709c61b7cfac3e9a9fd81482c1`
in [PR #74](https://github.com/YusukeIt0/dot-link/pull/74). Reviewers did not see
each other's findings before their first reports. Dotsweeper's existing prompt
used its configured `claude-opus-5-5`; the separate reviewer used GPT-6-astra.

| Reviewer | Initial findings | Incremental evidence | Wall time |
| --- | --- | --- | --- |
| Dotsweeper | Oversized published comments; non-acting events can displace a queued review | Concurrency exposure was additional to the other reviewer | 186 s workflow; 143 s model step ([run](https://github.com/YusukeIt0/dot-link/actions/runs/39064887553)) |
| GPT-6-astra | Editable comment attribution; scope discussion omitted; oversized published comments | Two additional locally reproduced evidence/authenticity gaps | 160 s, including source review and local checks |

There were four distinct initial findings, one overlap, and no rejected initial
finding after adjudication. Counts alone are not the benefit: the additional
review demonstrated that editing a bot-authored quality marker could change a
held decision to eligible, and that a scope-comment constraint was absent from
the model context. Both were fixed. No live unauthorized edit/merge was attempted
or observed. The comment-size reproduction produced 72,768 characters from a
30,774-byte valid model result; compact decisions and a final output bound fix it.
The scheduling exposure follows the documented one-pending-run concurrency rule;
live scheduling was not reproduced. Obvious non-acting events now use separate
groups. A follow-up review caught a whitespace-command classification mismatch,
also corrected to the documented exact command syntax.

A subsequent Dotsweeper review of `08f2f17` identified two further cases. Packaging
copies `assets/brand/orbit/DotLink.icns` into the Mac app; the broad website-asset
exception was therefore narrowed to actual site assets in both device impact and
evidence reuse. A stale-record requirement returned by the model previously lost
the whole report; publication now flags it as an evidence gap while the merge gate
remains strict. Both paths have regression coverage. Actual model frequency of
the latter case is unknown; the malformed/stale-response behavior is reproducible.
A further review of `bba100b` found that an unsupported advisory relationship
withheld otherwise valid technical findings, including when a PR cites its own
closing issue despite having no supplied relationship candidates. Unsupported or
malformed relationship rows are now omitted, with lifecycle coverage for issues
and PRs. The quality receipt still contains no advisory relationships; evidence
gaps and requirement validation remain strict. Live model frequency is unknown.
The optional suggestion to tolerate malformed evidence gaps was not adopted:
gaps affect merge eligibility and must fail closed. The pinned zizmor version is
installed from PyPI without a hash-locked dependency set; that supply-chain limit
remains in the read-only lint job and is not evidence of an observed compromise.

Unrelated REST metadata can conservatively hold a merge candidate. That optional
optimization is deferred until the inactive trial measures its frequency; it
cannot authorize an unsafe merge.

The current revision is authenticated through GraphQL's original author and last
editor, with body/update-time equality against REST. Live API reads confirmed
that a completed Dotsweeper comment identifies the bot as both author and editor.
Tests cover edits by a different repository writer and inconsistent API snapshots.
Source: [GitHub IssueComment schema](https://docs.github.com/en/graphql/reference/issues#issuecomment).

This sample justifies retaining an optional independent second review for
consequential fixes/control changes, not a permanent reviewer on every PR.
One control-plane PR cannot establish general precision, recall or cost benefit.
No monetary cost was measured. The [assurance guide](development-assurance.md)
defines the optional P0/P1 extension without installing another service.

Initial cloud CI took 121 s ([run](https://github.com/YusukeIt0/dot-link/actions/runs/39064887581)),
versus the historical 78 s median; this is not a matched performance experiment.
The new workflow-lint job took 9 s, including a 4 s checker step. Unit tests took
66 s in that run versus 35 s in the cited historical run. Additional fixtures and
runner variation are not isolated, so no overall speedup is claimed. The lint
step provides earlier configuration detection; full-context review remains.

Current PR checks and the bounded comparison belong in the PR evidence record.
The new default-branch review prompt and inactive coordinator require live
validation after a separately authorized merge. Fixtures and a local dry run do
not claim that those workflows have already run on GitHub.
