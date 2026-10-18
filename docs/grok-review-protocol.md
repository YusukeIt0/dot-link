# Grok review records

This is the machine-readable contract for the merge-side Grok hold, related to
[#84](https://github.com/YusukeIt0/dot-link/issues/84). The policy documentation is
in [PR #85](https://github.com/YusukeIt0/dot-link/pull/85). Deployment requires merging
both changes; publishing or installing the App does not activate the gate.

## Discovery and selection

Grok wakes on the routine webhook for a selected PR in `YusukeIt0/dot-link`; it
does not continuously poll for work. The body contains only `repo`, `pr` and
`head_sha`. It may read number, base/head SHA and labels to verify that input. It uses its own local
record of completed heads to avoid repeated posts; it must not read PR comments,
formal/inline reviews, Dotsweeper output or adjudication records to decide what to
review. Source input is the pinned diff, relevant source/tests and the target
issue problem definition. If a manually selected PR has no target issue, record
that absence in limitations and review only the allowed available input; do not
substitute PR discussion. Do not open the PR conversation page as review input.
If the head changes during review, publish only against the SHA actually reviewed;
the new head needs a new review.

The repository selection workflow adds `independent-review` when a PR is explicitly
classified with both `bug` and `P0`/`P1`, or has a GitHub closing-issue relationship
to an issue with both classifications in this repository. A PR classified as
`enhancement` is a proposal and is not automatically selected. Ordinary mentions,
related-issue references, title keywords and high-priority feature issues do not
qualify. For an unclassified fix, establish the bug classification and actual
closing relationship, or have the maintainer opt in manually. Classification and
closing relationships express intended fixes; Dotsweeper and Grok still verify
whether the code actually fixes the problem.

Manual `independent-review` labels opt in any PR and are never removed by automation.
A configured trusted maintainer may also post the standalone command
`/dotlink review2nd` on an open PR. The workflow adds the same label regardless
of priority. It fetches the current comment and verifies both author and editor
against `trustedMaintainers` in `config/development-policy.json` (numeric ID and
login, currently `YusukeIt0`); bots and other contributors cannot use the command.
Created and edited comments are supported. Immediately after adding the label,
the workflow sends one POST to the routine webhook. Grok never reads the command
comment. Automatic label additions use the same notification path. A synchronize
event for an already-selected PR sends one POST with its current head as well.

The workflow evaluates PR creation, reopening, edits, pushes and label changes,
including child PRs, plus Issue edits and label changes. It has no scheduled scan.
The workflow and checkout use trusted main even for child PR events; no child-base
or PR-head code runs with credentials. PR events have per-PR concurrency groups.
GitHub suppresses follow-up events for mutations made with `GITHUB_TOKEN`; those
callers must explicitly dispatch selection, with no polling fallback. Manual
sidebar fix links may likewise require a main-branch manual dispatch. Direct
manual label application is not a label write by this workflow and does not
itself notify. Notification delivery is best-effort, with a 10-second timeout,
no retries or redirects, and warnings only on missing configuration or failure.
Use `GROK_REVIEW_WEBHOOK_URL` and the complete Authorization header value in
`GROK_REVIEW_WEBHOOK_KEY`; never include review content in the request.
The merge
coordinator independently checks selection and holds qualifying unlabeled fixes
while label assignment catches up. API failures, incomplete issue/label pages and
head races fail closed. The classification uses current labels; maintainers
should preserve the defect's P0/P1 classification through review.

## App and publication

- App: `dotsweeper2nd`, App ID `5365493`.
- Bot: `dotsweeper2nd[bot]`, numeric user ID `344214582`.
- Installation: `172605999`, selected repository `YusukeIt0/dot-link` only.
- Permissions: Pull requests write and Metadata read; no Contents write.
- The GitHub App webhook remains disabled; no xAI API is used. The selection
  workflow sends wake-ups to the separate Grok routine webhook described above.
- Private key: maintainer-entered secret in Grok's own environment, used only for
  posting. It is not technically isolated from other processing there. Never put
  it in chat, logs, repository files or repository Actions secrets. Never execute
  untrusted repository code in that environment. Keep it separate from merger
  credentials.

Create a short-lived installation token restricted to `dot-link` and
`pull_requests: write`, using the App's JWT and installation ID. Use it only for:

```text
POST /repos/YusukeIt0/dot-link/issues/PR_NUMBER/comments
```

This is an ordinary PR conversation comment. Do not call formal review, label,
merge or repository-setting mutation endpoints. GitHub's PR write permission
cannot technically restrict the App to this single endpoint. Verify posting from
the response (comment ID and URL) without fetching the conversation. Do not
blindly retry an ambiguous failed POST; reconcile it outside the independent
reviewer's input rather than creating duplicates.

## Review comment

Start with the marker below and include exactly one fenced `json` block. The
remaining English prose may explain findings. Every finding needs a stable unique
ID within this review, a source location and concrete evidence. `read_scope` lists
actual files/ranges and issue problem definition read. `duration_seconds` records
elapsed review time; `limitations` identifies unverified behavior. Do not claim
static inspection executed tests or observed a device.

````markdown
<!-- dot-link-grok-review:v1 -->

```json
{
  "version": 1,
  "head": "<40-character reviewed commit SHA>",
  "reviewer": "Grok Bot / <actual model if available>",
  "duration_seconds": 120,
  "read_scope": ["diff BASE...HEAD", "src/example.ts:1-80", "Issue #N problem definition"],
  "findings": [
    {"id": "G1", "severity": "high", "file": "src/example.ts", "line": 42,
     "reason": "Concrete failure, triggering input and evidence."}
  ],
  "limitations": ["Static inspection only; no code or device tests executed."]
}
```
````

Use `findings: []` for no concrete findings. A later review comment supersedes an
earlier one; a malformed or stale latest comment holds the PR instead of falling
back to an old pass. Both author and current editor must be the configured App's
Bot identity; the REST App attribution must match the configured App ID.

## Adjudication

The implementing agent reads the findings and records its adjudication under a
configured trusted maintainer identity, separately from Grok. The maintainer need
not manually calculate hashes or read code. Authenticate both original author and
current editor. Every finding requires `fixed` or `rejected` plus source/test
reasons. Unresolved findings keep the hold. Fixing code changes the head and needs
a fresh Grok review before adjudication can clear that head.

Adjudication starts with `<!-- dot-link-grok-adjudication:v1 -->` and exactly one
fenced `json` block:

```json
{
  "version": 1,
  "head": "<current 40-character commit SHA>",
  "review_comment_id": 123456,
  "review_digest": "<SHA-256 from reviewDigest in scripts/grok-review.mjs>",
  "status": "completed",
  "summary": "Evidence-based disposition, unique findings, overlap and limitations.",
  "findings": [
    {"id": "G1", "disposition": "rejected", "evidence": "Source/test reference and reason."}
  ]
}
```

`reviewDigest` hashes the exact JSON object `{id, body, updated_at}` from the review
comment in that key order, with SHA-256 over `JSON.stringify` UTF-8 bytes. This
binds the disposition to the comment revision, including prose. Empty findings
still need an explicit completed record with a summary. A latest malformed,
stale, untrusted-edited or incomplete adjudication cannot reuse an older pass.

Leave `independent-review` attached. Every head update invalidates the previous evidence,
even for documentation-only commits. Passing this additional gate does not bypass
any existing acceptance, Dotsweeper, CI, protected-file or merge-authority rule.
