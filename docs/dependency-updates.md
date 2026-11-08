# Dependency updates

Dependency maintenance should reach the maintainer as a clear decision: what
changes, why it matters, what was checked and what remains uncertain. It must not
require reading the diff. See #274.

## Flow

1. Dependabot proposes updates weekly from `.github/dependabot.yml`:
   - npm in the repository root
   - npm in `tools/evenhub`
   - GitHub Actions

   Minor and patch version updates are grouped per ecosystem, giving one decision
   per batch. Majors and security updates arrive as separate PRs.
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
   accepted as-is (maintainer direction, 2026-11-09). The implementing agent pushes the fix to the
   Dependabot branch under the maintainer identity. That push refreshes CI and
   review automatically. Only then is the PR presented with a recommendation.
   A withheld or failed review is investigated and rerun, never treated as clean.

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
| Node.js in CI workflows and the bundled Mac runtime (`scripts/mac-runtime-manifest.json`), including the npm it ships | Not a Dependabot ecosystem here; covered by the pinned-runtime watch (next step of #274) |
| Sparkle version and checksum (`config/mac-update.json`) | Same; version and checksum must change together |
| tunnel-client and whisper.cpp (`scripts/mac-runtime-manifest.json`) | Same; version, URL and SHA-256 must change together |

The pinned-runtime watch alerts the maintainer with the dependency, the new
version or advisory, why no automatic proposal is generated, and the next action.
Version pins and integrity checks stay; floating versions are not a substitute
for maintenance.

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
