# Development assurance

The product owner decides purpose, behavior, UX, scope and acceptance. Development
agents investigate technical questions, design, implement, test, review and fix.
An issue's existence is not implementation authorization. Technical confidence
must come from evidence, not a request for the owner to read and approve code.

This supplements existing development instructions without changing branch policy
or authorizing main merges, distribution or publication. See the
[baseline audit](development-process-audit.md) and [inactive merge design](automatic-merging.md).

## Requirements and evidence

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

## Optional independent reviewer for consequential fixes

Keep Dotsweeper as the base. A P0/P1 fix or disputed concrete safety finding can
justify a separate model on the same frozen commit. Give it the agreed behavior,
diff and relevant source; initially withhold the first review's findings. It must
have no merge authority and must not execute untrusted code with credentials.

The implementing agent then adjudicates each finding against source/tests. Record
reviewer/model, exact commit, duration, valid unique findings, overlap, rejected
findings and unverified claims in the PR. Add a focused regression test or other
reproduction where meaningful, fix the problem and repeat the relevant checks.
If independent reviews disagree, investigate the evidence rather than voting.
This is an extension point, not a new required job, always-on service, or automatic
implementation permission. A permanent second reviewer needs demonstrated benefit.

## Validation boundaries

Workflow lint runs before the required `test` job; a lint skip/failure makes that
job fail. The model remains read-only, without test execution or posting tokens.
Protected workflow/script changes receive normal CI and independent review and
remain excluded from automatic merging. No device acceptance is required for
this control-plane change because it changes neither device runtime nor packaging.
