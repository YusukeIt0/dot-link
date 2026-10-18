# Development assurance

The product owner decides purpose, behavior, UX, scope and acceptance. Development
agents investigate technical questions, design, implement, test, review and fix.
An issue's existence is not implementation authorization. Technical confidence
must come from evidence, not a request for the owner to read and approve code.

This supplements existing development instructions without changing branch policy
or authorizing main merges, distribution or publication. See the
[baseline audit](development-process-audit.md) and [inactive merge design](automatic-merging.md).

## Requirements and evidence

Issue reviews investigate reports and ideas; they do not assess PR acceptance or
require an acceptance record. The publisher omits PR acceptance fields for issues,
including any such gaps returned by the model. Concrete investigation unknowns,
reproduction steps and device checks remain in findings, next steps and limitations;
grounded architecture and related-issue advice remain available. PR evidence
assessment and missing-record blockers are unchanged.

The implementing agent keeps a short requirements/evidence mapping in the PR.
Use observable behavior, not a checklist of internal components. Record test
results, static inspection, runtime observations, physical observations and unknown
behavior separately. A static model cannot claim it ran tests or observed a device.

For the disabled automatic-merge path, the agent can draft a structured record:

```sh
node scripts/prepare-acceptance.mjs <PR-number> <agreed-scope-issue> > /tmp/acceptance.md
```

This reads GitHub and writes only stdout. It never posts or approves anything.
Fill the requirements and actual evidence, mark scope approved only when the
product owner already authorized that scope, and leave unresolved product choices
visible. This is the agent's recording task; the owner need not edit JSON or give
a second technical approval. Publish/update the record as a PR comment using an
explicitly trusted maintainer identity after reviewing it for private information.
Its marker is `<!-- dot-link-acceptance:v1 -->` followed by one fenced JSON block.

```json
{
  "version": 1,
  "head": "<exact 40-character commit>",
  "scope": {"approved": true, "issue": 73, "digest": "<helper-generated digest>"},
  "requirements": [{"id": "R1", "expected": "The agreed observable behavior"}],
  "evidence": [{
    "kind": "automated",
    "result": "pass",
    "requirements": ["R1"],
    "reference": "<test/run/source reference>",
    "details": "What the assertions actually establish"
  }],
  "product_decisions": []
}
```

Kinds: `automated`, `static`, `runtime`, `device`. Results: `pass`, `fail`,
`unknown`. Runtime/device entries also require `commit`, `steps`, `observed`;
device entries require the exact `build`. Do not claim that fixture tests are
physical evidence. Requirements may need several evidence kinds. Dotsweeper
independently checks adequacy against implementation; merely supplying one
passing row does not establish the behavior.

Record the current head even if earlier device evidence is reused. Reuse is
accepted only when its source is an ancestor and subsequent changes are bounded
docs/tests/site/website assets or strictly version-only JSON metadata. Runtime
changes invalidate applicability. Renames or truncated comparisons fail closed.
Unchanged device evidence does not need to be physically repeated merely to update
a documentation or version commit. The agent still verifies its assumptions.

Any human scope-issue edit/comment changes the scope digest; any PR description,
human discussion, formal review or inline feedback change invalidates the review
receipt. Update the record and re-review after a substantive change. The latest
trusted record wins, including a malformed or stale one: an older passing record
cannot silently replace it. Failure and unknown evidence are not passes.
Both original authorship and the current revision's editor are authenticated;
editing someone else's acceptance comment does not inherit their authority.

If a model refers to an ID outside the current acceptance record, the published
review keeps its technical findings and marks that row as an evidence gap with
unknown scope. The automatic gate still rejects unknown IDs; this recovery does
not turn stale evidence into acceptance.

The updated workflow starts re-review on trusted-author pushes and trusted
acceptance-comment creation/editing, in addition to existing review requests.
Scope issue edits invalidate the gate but do not automatically launch every linked
PR review; the agent updates its record and requests review. Dotsweeper gets CI
metadata and bounded evidence context; deterministic code verifies CI completion.

For physical acceptance, state one session goal and finish condition, exact
device/build and starting state, numbered operations and expected user-visible
results. Monitor machine-readable state directly. Collect physical-only
observations together at the end and report pass/fail/unverified separately.

## Technical findings and design advice

For a technical issue explain: what the user experiences; verified facts versus
inference and unknowns; the technical decision and evidence; the UX effect of the
fix; and whether a product choice is needed. Investigate and fix technical issues
autonomously within the authorized scope. Low severity is not a dismissal reason.

Architecture advice is separate and non-blocking. At most three concrete signals
identify the file, evidence, triggering future change, impact and next step.
Empty advice is valid. A confirmed defect belongs in findings, not advice. File
length or abstract best practice alone is insufficient. No automatic refactor is
created from advice.

Issue review receives at most eight candidates from the latest 100 updated
issues/PR entries, ranked by title terms and explicit issue references. It can
suggest related, possible duplicate, dependency or possibly resolved relationships
only for supplied candidates. This is bounded discovery, not exhaustive search.
The agent maintains relevant issue relationships during authorized work; the
reviewer does not close issues or authorize implementation. Existing triage labels
and human-label preservation remain unchanged.

## Independent Grok Bot review

Dotsweeper remains the base reviewer. Grok Bot is the maintainer's separate AI
assistant, operating from its own environment; this integration does not call the
xAI API. After each successful addition of `independent-review`, the selection
workflow sends one POST to Grok's routine webhook in the same execution, including
selection by the maintainer-only `/dotlink review2nd` PR comment command.
Use Actions secrets `GROK_REVIEW_WEBHOOK_URL` for the HTTPS endpoint and
`GROK_REVIEW_WEBHOOK_KEY` as the complete `Authorization` header value.
The JSON body contains only `repo`, `pr`, and `head_sha`; never include comments or
review content. Missing secrets, timeouts and unsuccessful POSTs produce a warning
only: keep the label and merge hold, and do not fail selection. Do not retry or
follow redirects. Deliver immediately after the label write, not through a separate
`labeled` workflow, since labels written using `GITHUB_TOKEN` do not trigger it.
The same three fields are sent once on a `synchronize` event for an already
selected PR, using its current head. Selection runs on PR creation, reopening,
edits, pushes and label changes, including child PRs, and on Issue edits and label
changes. Issue events re-evaluate open PRs for qualifying fix relationships. There
is no scheduled scan or polling loop. Event-driven checks of existing labels and
dry runs do not notify. Direct manual label additions are not label
writes by this workflow. The merge hold always requires current-head review and
adjudication, regardless of notification delivery.

### Selection

Every PR that fixes a P0/P1 bug receives `independent-review` automatically when opened.
Re-evaluate selection after PR edits, fix-link changes and linked-issue priority
or category changes, and before merging, so later classification cannot escape
review. Never remove the label automatically.
Selection requires a concrete bug-fix relationship and a P0/P1 bug classification;
a feature proposal or an incidental reference to a high-priority issue is not a
qualifying fix. The maintainer can also apply `independent-review` manually to any PR,
including P2/P3 work, or post `/dotlink review2nd` as a standalone PR comment
to have the workflow apply it. Only configured trusted maintainers may use this
command; verify both original author and current editor by numeric identity.
Preserve this manual selection. Grok does not add or remove
labels. Label assignment belongs to repository automation and the maintainer.

### Independent input and publication

Freeze the exact head commit for each review. Grok reads only the diff, relevant
source and tests, and the target issue's problem definition. PR discovery metadata
(number, head, base and labels) is permitted for selecting and pinning that input.
It does not read PR comments, formal or inline review results, or Dotsweeper output.
Use API projections or source retrieval instead of a PR conversation page. Each
comment identifies the reviewer/model, exact head, duration, actual files/ranges
and issue problem definition read, findings with evidence, and limitations.
Distinguish static inspection from tests actually executed and physical evidence.

Publish in English as an ordinary PR conversation comment using the dedicated
`dotsweeper2nd` GitHub App. The only repository permissions are
**Pull requests: Read and write** and mandatory **Metadata: Read-only**. Install it
only on `YusukeIt0/dot-link`. Keep its App, key and secrets separate from
`dotsweeper-merge`. Do not submit Approve, Request changes or formal review comments,
change labels, merge, or alter repository settings. GitHub's PR write permission
also permits actions beyond ordinary comments: this narrower use is enforced by
the posting procedure and operating instructions, not by a comment-only GitHub
permission.

The private key stays in Grok's environment and is entered by the maintainer
through a dedicated secret input, never a chat message, repository file or log.
That environment cannot isolate the key from ordinary processing; using it only
for posting is an operational rule, not a technical isolation guarantee. Read
sources through the existing read-only access. Do not execute untrusted repository
code in the credential-bearing environment. Do not place this key in repository
Actions secrets or reuse merger credentials.

### Adjudication and automatic merge hold

The merge coordinator, not Grok, owns the hold. A PR with `independent-review` is excluded
from automatic merging until **both** an authenticated Grok comment for its current
head and completed adjudication of that review for the same head exist. Either
missing item holds the PR. Authenticate the dedicated App's identity and the
trusted adjudicator, including edits; an arbitrary comment claiming completion
is not evidence. Bind adjudication to the specific review revision, so editing or
replacing a review cannot silently inherit an earlier disposition.

The implementing agent adjudicates every finding against source/tests and records
valid unique findings, overlap, rejected findings with reasons, and unverified
claims. Add a focused regression test or reproduction where meaningful, fix the
problem and repeat relevant checks. Investigate disagreements instead of voting.
Unresolved findings and unverified blocking claims keep the hold; an empty findings
list still requires an explicit completed adjudication record.

Any head change invalidates the previous Grok review and adjudication for merge
purposes, including documentation-only changes. Leave `independent-review` attached after
completion so a new head is held again. Clearing this hold only permits evaluation
of the existing merge policy; it does not bypass Dotsweeper, CI, acceptance,
protected-change restrictions or maintainer merge authority.

This is label-selected review, not a second required CI job for every PR. The
webhook wakes Grok without continuous polling; execution stays in its own
environment. Measure useful unique findings, overlap, rejected findings, limitations
and duration to assess its value.

**Rollout:** this section defines the agreed policy. Automatic label assignment
and the merge-side hold are delivered in a separate implementation PR tracked by
[#84](https://github.com/YusukeIt0/dot-link/issues/84). App installation and this
policy document alone do not enable either mechanism. Before using it on a live
PR, ensure the merge-side hold is deployed or the PR is otherwise excluded by the
merge operator until review and adjudication finish.

## Validation boundaries

Workflow lint runs before the required `test` job; a lint skip/failure makes that
job fail. The Dotsweeper review model remains read-only, without test execution or posting
tokens. Grok uses the separate publication arrangement above.
Protected workflow/script changes receive normal CI and independent review and
remain excluded from automatic merging. No device acceptance is required for
this control-plane change because it changes neither device runtime nor packaging.
