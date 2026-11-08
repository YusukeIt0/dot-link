# Dependency updates

Dependency maintenance should reach the maintainer as a clear decision: what
changes, why it matters, what was checked and what remains uncertain. It must not
require reading the diff. See #274.

## Flow

1. Dependabot proposes updates weekly from `.github/dependabot.yml`:
   - npm in the repository root
   - npm in `tools/evenhub`
   - GitHub Actions

   All of them, including majors, arrive as one weekly pull request through a
   multi-ecosystem group (maintainer decision, 2026-11-09, #286). That means one
   decision per week. A breaking major in the batch is fixed on that PR by the
   implementing AI before the decision. Security updates arrive separately and
   immediately.
2. Each Dependabot PR runs the ordinary CI (`Tests`; `Branch validation` for the
   branch push, as for any branch). Existing duplicate avoidance and cancellation
   are unchanged.
3. dotsweeper reviews the PR automatically on open, ready-for-review and every
   Dependabot update or rebase. Maintainer pushes onto the PR also refresh it.
   The review starts with a decision brief: the dependency and version changes,
   reason and urgency, any advisory (a reported vulnerable version is
   distinguished from evidence of actual exposure), expected product impact,
   checks completed, unresolved findings and a recommendation.
4. The PR stops for the maintainer's explicit merge decision. The automatic merge
   coordinator only merges PRs authored by a trusted maintainer, so dependency
   PRs are always held, even when every check passes.
5. Review findings on a dependency PR are fixed before the merge decision, not
   accepted as-is (maintainer direction, 2026-11-09). The implementing AI, Codex or
   Claude Code, makes the fix on the Dependabot branch; the maintainer does not.
   Its commits use the repository's required maintainer Git identity. That push
   refreshes CI and review automatically. Only then is the PR presented with a
   recommendation. A withheld or failed review is investigated and rerun, never
   treated as clean.

   Once someone else commits to a Dependabot branch, Dependabot stops rebasing or
   updating that PR. The implementing AI then keeps it current itself, updating
   the branch from `main` and resolving conflicts, so CI and review rerun on the
   new revision. Do not use `@dependabot rebase` or `@dependabot recreate`: they
   force-push and discard the fix commits. If the fixes are abandoned, close the PR
   and let the next scheduled run propose the update again.

Evidence must match the current PR revision. Missing, skipped, cancelled, failed
or stale CI and review stay visible and never count as verification. Merging still
uses `node scripts/check-review-before-merge.mjs <PR>`.

## Repository settings

Checked 2026-11-09: Dependabot alerts and Dependabot security updates are
enabled, as are secret scanning and push protection. Security updates create
their own PRs and follow the same review and decision flow.

## Coverage and gaps

| Source | Tracking |
| --- | --- |
| npm (root, `tools/evenhub`) and lockfiles | Dependabot version updates and security alerts |
| GitHub Actions (SHA-pinned with version comments) | Dependabot version updates |
| Node.js in CI workflows and the bundled Mac runtime (`scripts/mac-runtime-manifest.json`), including the npm it ships | Pinned-runtime watch: newer releases on the pinned major, security releases, bundled npm, and CI/bundle version drift |
| Sparkle version and checksum (`config/mac-update.json`) | Pinned-runtime watch: newer release and repository advisories published after the pinned release |
| tunnel-client and whisper.cpp (`scripts/mac-runtime-manifest.json`) | Pinned-runtime watch: same as Sparkle |

### Pinned-runtime watch

`.github/workflows/pinned-runtime-watch.yml` runs weekly (Monday 03:17 UTC) and on
manual dispatch from `main`. `scripts/check-pinned-runtimes.mjs` reads every pin
from the repository and compares it with the official Node.js release list and the
upstream GitHub releases and published advisories. For Node.js it also reads the official release schedule (`nodejs/Release` `schedule.json`) and reports when the pinned major is within 180 days of end-of-life, naming the latest LTS. An unavailable schedule or advisory lookup is reported as unknown and keeps the issue open. It keeps one tracking issue,
"Pinned runtime updates available", opened by `github-actions`. The issue is
created when something is actionable, updated in place when the report changes,
and closed when everything is current. Each entry gives the update or advisory,
why no automatic PR is generated (the version must change together with its
URL/checksum and be verified against upstream), and the next action. An advisory
is reported upstream; it does not establish exposure in Dot Link.

The watch never edits pins, checksums or code, and it needs only `contents: read`
and `issues: write`. Version pins and integrity checks stay; floating versions are
not a substitute for maintenance. Run `node scripts/check-pinned-runtimes.mjs`
locally to print the report without touching issues.

## Operational limits

- Dependabot-triggered `pull_request_target` runs must receive the review
  credentials. Two steps depend on them. If the App key is missing, intake fails at
  "Create dotsweeper publishing token" before any PR comment is posted, so the
  failure shows only in the Actions tab. If the subscription credential is missing,
  the run fails visibly at "Check subscription credential". GitHub documents that
  `pull_request_target` runs against a base not created by Dependabot (here `main`)
  receive normal secrets. This is confirmed on the first Dependabot PR after this
  change; if that PR shows no dotsweeper comment, check the intake token step first.
- A PR left open while `main` advances must be updated (`@dependabot rebase` or a
  branch update) before merging. That reruns CI and review for the new revision.
