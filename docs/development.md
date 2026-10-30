# Development

## Tests

Use a supported Node.js release with current security fixes. The packaged runtime
and CI use 22.23.4, pinned in `scripts/mac-runtime-manifest.json`. The
`engines.node` value `>=22.18.0` is the native TypeScript execution compatibility
floor, not a security guarantee. A higher lower bound alone would still admit
vulnerable versions on other major lines. For the October 21, 2026 security
release, the patched versions are 22.23.4, 24.22.1 and 26.12.1; use those or later
patched releases on a supported line. See the [official advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

```sh
npm ci
npm test
npm run test:http
npm run build
sh scripts/test-notification-native.sh
```

Main pushes and pull requests run these checks in Tests. Work-branch pushes use Branch validation until an open PR owns validation for the same head. Passing checks do not publish an application automatically. Only a tested release updates installed clients.

MCP `serverInfo.version` reports the root `package.json` version, shared with the
Even app. It is not the Mac app release/build number. For Mac update or support
identification, use the Mac app's version and build; a Mac-only release can retain
the same MCP package version.

### Verify tool-definition updates in the active consumer

For a tool-schema change, compare the running relay's authenticated `tools/list`,
ChatGPT's registered app details, and the definitions available to the existing
Dot that actually answers device events. A successful refresh or a new test chat
does not prove that an already-running Dot has adopted the new schema.

During conversation-ordering acceptance, the relay and registered app exposed
`utterance_id` on both `send_message_to_g2` and `respond_to_location`, while the
existing Dot retained the old definitions even after an explicit plugin mention.
After the maintainer restarted that Dot, it exposed the new fields and a new
location answer was stored with its question. Treat this as an observed update
requirement, not a guarantee about every host version. Follow the user guide's
update steps before repeating affected physical acceptance.

Verify actual stored question references as well as the rendered pages. Keep
first answers, linked follow-ups and independent proactive messages distinct.
Do not infer an association from timing, rewrite old history, or count a
per-user instruction to the AI as product acceptance. Keep private conversation
text, locations, credentials and identifiers out of public evidence.

### Location response errors

See the [location response contract](tool-response-errors.md#location-response-contract)
for the complete `respond_to_location` reason list, argument constraints,
validation order, consent/freshness guards, retry semantics and privacy boundary.
Maintain those details there rather than duplicating an error table in this guide.

For the standalone introduction page, see [page maintenance and deployment](introduction-page.md).

### Tool and subscription response errors

Conversation/notification mutations, all four read tools and event subscription
operations return fixed `error.data.reason` values. Routing distinguishes unknown
operations from known but unavailable features. Expected rejections use `-32602`;
unexpected failures use `-32603` with `internal_error`. Callback verification
retains `-32015` with `challenge_failed`. These are ordinary English protocol responses,
not application UI or opt-in diagnostic collection. See
[tool response reasons](tool-response-errors.md) for the vocabulary, module
ownership, persistence/retry semantics and compatibility boundaries.

For Even application state ownership and diagnosis, see [Even runtime ownership](even-runtime.md).

For translation resources, locale selection and adding a language, see
[Application localization](localization.md).

## Build the Mac app

Apple Silicon macOS, Xcode Command Line Tools, Python 3 and CMake are required.

```sh
python3 scripts/prepare-mac-runtime.py
node scripts/prepare-sparkle.mjs
node scripts/test-mac-update-driver.mjs
node scripts/build-mac-app.mjs
```

Output: `.runtime/mac-app/Dot Link.app`. Runtime downloads and Sparkle are pinned by version and SHA-256. No speech model, account credential, pairing, or conversation data is included. The speech model downloads during initial setup.

### Validation builds and conversation-state rollback

Before running a validation relay against an existing installation, stop its owned services and make an owner-only local backup of the installed app plus `.runtime/bridge-state.json` and its `.runtime/bridge-state.json.photos` directory. Use the configured installation directory (normally `~/Library/Application Support/Dot Link`), not an unrelated checkout. Verify the backup against the originals before starting the test. These files contain private conversations and may contain credentials; never upload them or include them in a build.

Question-linked outbound records add `utterance_id` and `initial_reply` fields. Older relay versions reject these fields, so replacing only the app is not a supported downgrade after linked messages have been stored. To return to the previous version, stop the relay, preserve the post-test state separately, and restore the verified app and matching pre-test state/photo backup together before restarting. The restored history ends at the backup time; messages accepted during testing are retained only in the separate post-test copy. Do not delete the state file to force startup, and do not replay pending messages to recover history. If the backup is absent, retain the newer compatible relay until a reviewed migration is available.

The app uses one public update feed at `https://raw.githubusercontent.com/YusukeIt0/dot-link/main/updates/mac/appcast.xml`. Release ZIPs are downloaded from the public GitHub Releases repository configured by `downloadRepository` in `config/mac-update.json`. Users need no GitHub account, token, or development-channel setting.

### Manual update behavior

Choosing **Update** explicitly permits interrupting the connection and conversation in progress. After Sparkle verifies the download, the Mac app uses `update-prepare-manual` to journal the prior running/paused state, back up the app, and stop its owned services through the normal lifecycle. It does not wait for a device long-poll, transcription, or pending reply to become idle. Pairing, credentials, and persisted messages are retained; unsent speech may need to be repeated. A stopped relay remains stopped after relaunch, while a running relay is restored and health-checked.

The automatic path retains its idle checks; automatic updates remain disabled. Manual approval does not bypass app verification, service ownership checks, service termination, or recovery.

Update storage is serialized across setup helpers by an owner-only file and an OS advisory lock. Preparation verifies the installed app, prunes obsolete backups, creates a monotonically named backup with an ownership receipt, and verifies the copied app before writing the recovery journal. Recovery keeps its journal until the intended running/paused state is restored. A one-shot child performs startup cleanup after recovery returns, keeping signature checks and pruning off the GUI startup path. It never recovers an active journal and shares the same storage lock. Cleanup retains the newest verified rollback generation and removes superseded recognized generations. Startup without a journal retries cleanup only when the relay is healthy or intentionally stopped; the installed app is verified before deletion. Legacy timestamp directories are eligible only when they contain the recognized app (or are empty interrupted deletions). New ownership receipts allow incomplete copies to be reclaimed. Unknown contents, unsafe paths, and backup executables still in use are preserved. Eligible deletions are atomically renamed to reserved `<generation>.removing` directories before recursive removal, so interrupted removal remains retryable even after its app or receipt is partially deleted. The updater leaves Sparkle's own downloads/staging under Sparkle's ownership.

Cleanup failures do not fail an otherwise healthy update. A bounded diagnostic line reports deferred/incomplete cleanup without paths or private content; a later start or update retries it. Active recovery may temporarily require an extra generation. This retention is for app bundles, not conversation-state rollback or arbitrary development backups. Changes to persisted state still require a compatible migration/rollback plan.

Run `node --test tests/update-storage.test.mjs tests/app-update.test.mjs tests/update-exit-recovery.test.mjs` for repeated-update and cleanup failure coverage. These include 365 storage cycles, legacy accumulation, failed first copies, deletion retry, active recovery protection, unsafe paths, concurrent helpers, crashed lock owners and repeated prepare/finish cycles.

If preparation fails, **Retry update** reuses the verified installer while Dot Link stays open. A failed rollback exposes **Retry recovery** before another installation attempt. Quitting with a retained installer requires explicit confirmation that the download will be discarded. Sparkle's ready-to-install `dismiss` choice is not a safe cache operation: it can install on application exit before service preparation. See the [Sparkle user driver contract](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUserDriver.html).

GUI preparation also arms a detached recovery process from the verified app backup before handing installation to Sparkle. It watches the original host process and the pinned Sparkle installer's `app.tripsurf.dotlink.mac-sparkle-updater` and `-sparkle-progress` launch jobs. Only after the host exits and both jobs disappear does it allow a short relaunch grace period, then reopen the verified installed app once if that same recovery journal remains and no app is running. Startup performs the existing recovery and preserves the previous running/paused state. Successful recovery or a changed journal ends the watcher. A live host, uncertain process state, or an installer still running never triggers fallback; observation expires after 15 minutes without changing the journal. Failure to arm the watcher rolls preparation back and retains the downloaded update for retry. This is an update-scoped process, not a persistent login service.

When the live host takes over rollback, it cancels the watcher before recovery checks. Even if that recovery fails, a subsequent explicit Quit is respected. The job names and failure ordering come from the pinned [Sparkle 2.10.0 installer launcher](https://github.com/sparkle-project/Sparkle/blob/2.10.0/InstallerLauncher/SUInstallerLauncher.m) and [installer](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Autoupdate/AppInstaller.m). Revalidate this integration when upgrading Sparkle. The watcher does not replace an absent or unverifiable installed app with its backup, and it does not race a stuck installer; the journal remains available for explicit recovery.

For changes to this path, run `node --test tests/app-update.test.mjs tests/app-lifecycle.test.mjs tests/update-exit-recovery.test.mjs` and `node scripts/test-mac-update-driver.mjs` (requires macOS AppKit access). These fixture checks do not establish physical update success. Before merge, test a configured Mac using a PR-commit build as the **starting updater** and a known signed target. An existing official release can be reused by giving the starting Beta a lower test-only build number; record this metadata override and leave the signed target/feed unchanged. Updating an old production app to the PR build still runs the old updater and does not validate this change.

Record the source commit, starting/target build identities, pairing/settings comparison, and outcomes for: connected idle, interrupted speech/transcription/reply, initially paused, preparation failure and retained-download retry, install failure and recovery, and quit while a verified installer is retained. Keep physical observations separate from injected failures and fixture results.

## Required documentation check for every change and distribution

Every implementation PR must check whether its changes affect user-facing release
notes, `docs/privacy.md`, setup guidance, dependency/version descriptions, or
permissions. Update affected documents in the same change. Record the documents
checked and the result in the PR; if no update is needed, state the reason.

Repeat this check against the exact source and artifact before **every** Mac or
Even distribution, including validation builds and private uploads. Compare with
the previous distributed version on that channel, not just the last commit:

- Verify release notes cover the cumulative user-visible changes. Even changes
  belong in `docs/even-release-notes.md`; Mac release notes must match the archive
  and update feed. Keep issue numbers, commits, test results and internal status
  out of user-facing notes.
- Check the privacy baseline and actual behavior: microphone/wake input,
  location, notifications, storage/retention, diagnostics, external services,
  consent, stopping and deletion. A version bump alone is not a privacy audit.
- Verify dependency versions, setup/update instructions and permission text
  against the built artifact. Inspect the privacy document copied into the Mac
  bundle. On Even Hub, check and save permissions and English change notes on
  the actual selected build, then read them back.
- Record source/build identity, comparison version, reviewed documents and
  corrections (or why none were needed) in the existing PR/issue/release record.
  Resolve discrepancies before distribution. Do not create a release-tracking
  issue solely for this check.

This is a required implementation and distribution gate, not optional cleanup.
Mac release, Even upload, maintainer review submission and general publication
remain separate stages. The maintainer presses the Even review-submission button.

## Maintainer release

The maintainer needs authenticated `gh`, write access to this repository, and the existing Ed25519 signing key at `.runtime/update-signing/ed25519.key` with mode 600. This key is never included in a build, commit, or workflow. Contributors can build and test without the release key; only the maintainer signs official updates.

1. Complete the [required documentation check](#required-documentation-check-for-every-change-and-distribution), then update `CFBundleShortVersionString` and increase `CFBundleVersion` in `native/DotLinkSetup/Info.plist`.
2. Run tests, the native driver test, and the Mac build above. Inspect the app and changes. Push the matching source to `main`.
3. Write release notes to a local text file and run:

```sh
node scripts/release-mac-update.mjs '.runtime/mac-app/Dot Link.app' /path/to/release-notes.txt
```

4. Commit the generated `updates/mac/appcast.xml` on a release branch, open a pull request, and complete the required CI/review checks before merging it. Do not bypass main branch protection. Merging the signed feed enables client discovery of the release.
5. Fetch the public feed and ZIP without authentication, verify signatures, and check the update in the app. A failed network request must never be reported as “up to date.”

The release helper packages the app, verifies its signature, signs the ZIP, uploads a release, and signs the feed. The release points to the current public `main` commit. Do not publish mismatched source and binaries. Keep release signing local; do not put personal credentials into GitHub Actions to make installation work.

## Even companion

```sh
npm run package:beta
```

Work-branch validation builds show `Beta` beside the numeric app version. Use `npm run build` and `node scripts/package-beta.mjs` for those builds; the packager requires clean matching source and records its commit. Keep package ID and pairing identity stable, and increment the numeric version when a new upload requires it.

Complete the [required documentation check](#required-documentation-check-for-every-change-and-distribution) before distributing either build type. Package code merged into main with `npm run package:release` (which runs `build:release` and the shared asset/secret/SDK checks), without the Beta marker and without opt-in diagnostics. The version update must also be merged before packaging the main release. Private storage in Even Hub before review does not make a main release a Beta. Upload authorization does not authorize review submission or publication.

Independent defects discovered during the refactor may use a child fix branch and PR targeting the parent branch. Verify the fix before integrating it and preserve the parent acceptance criteria. Keep one overall outcome until automated checks, review and affected physical verification are complete. Main merge requires explicit maintainer instruction.

Reuse an uploaded build when it can answer the verification question; upload a new build when changed code requires it, within the authorized scope.

Even Hub publication is separate from Mac Releases. The internal package IDs remain stable for compatibility. Do not rename an installed data directory or recreate pairing when changing a display name.

## Repository rename compatibility

The repository is `YusukeIt0/dot-link` (formerly `dot-link-app`). The signed feed and future release enclosures intentionally use the `dot-link-app` download alias, which GitHub redirects to `dot-link`. Installed 0.2.21 clients restrict downloads to that original path. `downloadRepository` keeps publisher and client URL validation consistent; do not reuse the old name or remove this compatibility without a client migration. New builds use the canonical `dot-link` feed URL. Existing signed releases are unchanged.

## Operations and diagnostics

Use the Mac app's pause, resume, quit and update controls for normal operation; see the [user guide](setup.md#pause-quit-and-uninstall). Dot Link owns its launchd jobs and must not change unrelated jobs or network settings. Data, credentials, models, history and pairing live outside the app bundle.

Updates retain the data directory and paused state. Before installation, the app records a recovery journal and backs up the app and service configuration. Manual updates explicitly permit interruption; the currently disabled automatic path retains its idle checks. Backups are retained; automatic rollback of an app that cannot launch is not implemented.

For source-based diagnostics, run `node scripts/setup.mjs status --voice-only` from the installation directory. Do not start another relay on the same ports. Runtime files may contain credentials: never attach the whole `.runtime` directory to an issue. For iPhone layout investigation, see [viewport diagnostics](viewport-diagnostics.md).


## Parent and child PR review

For a cohesive change split into substantial dependent steps, track the outcome in a parent issue and integration branch, with native sub-issues and child PRs targeting that branch. Define the ownership and dependency order first. Update each dependent child from the integrated parent before starting its work; small fixes do not need this hierarchy. Keep acceptance evidence in the issues/PRs, not a duplicate backlog.

Automated review executes helpers from trusted main. A child review pins its target branch and commit and supplies the exact main-to-base delta as read-only context before the PR diff. No reviewed base/head code is checked out or executed by the review job. Large base deltas stop preparation with a Needs a smaller scope result rather than silently omitting context. Moving the base or retargeting the PR invalidates the receipt. The child gate also verifies that the exact tested head contains the current parent commit (ahead or identical, with that parent as merge base). If the parent has advanced or a new target is not contained in the child, update the child and rerun CI/review. PR CI must record the current parent ref/SHA. Branch push CI is pre-PR feedback and cannot certify integration. A run against an unrelated old target cannot qualify.

The normal gate remains `node scripts/check-review-before-merge.mjs <PR>` for main. For child integration, explicitly name the intended parent:

```sh
node scripts/check-review-before-merge.mjs <PR> --base refactor/even-state-coordination
```

Both paths require completed intake/review/report jobs, current review inputs, clean mergeability and passing branch-required CI. The child CI lookup supports in-repository heads and PR runs whose API metadata identifies the PR; fork child PRs with missing run association remain NOT READY. A child target may have no branch-protection requirements; the child gate additionally requires the completed product CI workflow and its test job for the exact head, even in that case. Read the findings; READY is not merge authorization. Integrate children in dependency order, then verify the combined parent with automated checks, review and the affected physical flows. Give device testers the exact build, starting state, numbered actions, expected results and requested observations. Main merge, upload/distribution, review submission and publication retain separate authorization stages.

When automation or repository settings conflict with this workflow, record the mismatch and agree on a meaningful workflow change before proceeding. A skipped review is not a completed review. For existing parent branches that predate a workflow update, dispatch the review from main (`gh workflow run claude-review.yml --ref main -f item_number=<PR>`) so the updated workflow runs.

## Notification migration proof

Both Mac notification diagnostic producers write schema version 3 with a stable
`forwardingResult` for each synthetic probe. Only `relay_accepted` can authorize
retiring the owned legacy notification helper; the human-readable `forwarding`
field is informational. Trust, installed-process identity, proof/probe freshness,
OS registration, body match and selection at detection remain required.
Text-only diagnostics from older builds cannot authorize migration: rerun the
notification test in the current installed app. A migration probe uses its direct
receipt path even if notification sharing was already enabled, and is excluded
from the general delivery ledger to prevent duplicate forwarding.

### Review input bounds

Automated review accepts up to 500,000 bytes for a PR diff and separately for
the main-to-parent context of a child PR. These bounds allow complete shared
translation catalogs to be reviewed. Larger inputs stop without an assessment;
no files are silently omitted. Discussion, file-count, verification-context,
authorization and result-validation bounds remain separate.

### Acceptance effort and deterministic boundary tests

Use automated tests, simulation or a controlled test environment for races, narrow timing windows, delayed replies, expiry and fault timing. Do not ask the maintainer to race an incoming response or repeat timing-sensitive actions. Physical acceptance covers ordinary use and observations unavailable to automation, such as the actual glasses display and speech. Read machine-visible state directly and reuse applicable evidence when the tested runtime is unchanged. Record automated boundary coverage separately from physical observations; absence of a manual race reproduction alone is not a release blocker.

The maintainer defines UX and reports the experience. The implementer owns implementation choices, dependency order, test design and issue/PR integration. Complete child work in order, integrate it into the parent and close the child PR before advancing the overall outcome. Preserve separate main-merge and distribution authorization boundaries without asking the maintainer to manage internal task sequencing.

## Speech-presence check

The Mac transcription boundary checks every completed recording with the bundled
Silero VAD before selecting or contacting a provider. Manual, wake and manual
takeover recordings use the same check. No language detection, transcript
blacklist, interface locale or speaker profile influences this decision.

A per-recording Node worker loads the existing local WASM and Silero assets from
`dist/wake-assets` (or `public/wake-assets` in a source checkout). It keeps audio
in memory, has a 15-second deadline, and is terminated after completion or
cancellation. An unavailable detector fails the request without falling through
to a provider. A no-speech result returns an empty transcript, which the existing
Even flow treats as idle without sending text or draft photos.

The detector receives a peak-normalized copy (target 0.9, amplification capped at 128×); STT receives the unmodified WAV. The cap prevents near-zero quantization noise from being amplified to full scale.
Presence detection uses the same 0.5 probability threshold as wake detection but
a 64 ms minimum speech interval to accommodate short acknowledgements. Wake
endpointing retains its existing 300 ms minimum and 1.2-second silence interval.
These serve different purposes: preserving a brief completed answer versus
ending an automatically captured utterance. The old whole-recording RMS cutoff
is removed because silence surrounding a quiet phrase can lower its average.

Run `node --test tests/speech-presence.test.ts tests/display-lifecycle.test.mjs`
and the HTTP suite. The offline regression corpus contains short and sentence
samples from two synthetic voices in each of the seven interface languages at original, 10% and 1% amplitude;
noise fixtures contain no microphone recordings. These checks do not establish
accuracy across all voices, accents, background sounds or G2 microphone levels.
Speech detection also cannot distinguish the wearer from another speaker or
media. Keep that separate from speaker-role work.

### CI ownership and recovery

`Tests` is canonical for main pushes and PRs (including drafts and child PRs).
`Branch validation` checks non-main pushes without a matching open PR. Its distinct
`branch-test` check cannot replace required `test`. Read failures retain branch
validation. PR creation concurrent with a branch run may temporarily run both;
branch-only and merge-context evidence are not interchangeable.

Review evidence and both merge gates share `scripts/ci-evidence.mjs`: select the
latest matching PR workflow and its latest attempt for the exact head/base, then
require all jobs to succeed. Never search backward for a passing run. Cancelled,
skipped, missing and stale evidence holds integration. Unknown fork association
also holds it. Update a child after its parent advances and rerun CI/review.

Tests and branch validation use separate cancellation groups by PR/ref. Manual
retries are isolated from ordinary runs so an old retry cannot cancel current
validation. GitHub does not guarantee dispatch order: inspect the latest head and
run after cancellation. A supersession failure requires updating the PR head from
the current base (or another fresh PR event); rerunning the old event cannot refresh
its pinned base. Rerun current-context infrastructure failures only when needed.
Do not repeatedly restart healthy queued runs or describe runner-capacity recovery
as a permanent capacity fix. Preserve independent review queues and Pages deploy
serialization. Record run/attempt, head/base, execution and queue durations,
conclusions, selected evidence and any recovery in the existing PR.

See [technical ownership](development-assurance.md#technical-ownership-across-agent-sessions)
for the division between UX decisions and agent-owned implementation/verification.

CI provenance is pinned in the `CI v1` run title at dispatch. GitHub's associated
PR metadata can change when a PR is retargeted; it is not proof of the tested base.
The selector checks both the fixed receipt and API association. A newer associated
run with missing/malformed provenance holds integration rather than reviving an
older success. Runs from before receipt adoption need a fresh PR-triggered run;
a rerun of an old event cannot add a new receipt.

Title/body-only edits use a lightweight Ubuntu `test` check that verifies the
latest real full Tests result for exactly the same repository, PR, head and base.
It uses the shared CI selector and checks both original required jobs; it never
accepts another metadata check as test evidence. A pending full run is awaited
for at most 38 minutes; failed, cancelled, skipped, missing or stale evidence
cannot pass. Current refs and the selected attempt are rechecked before success.
The metadata job has a 40-minute timeout, while full workflow lint and product
jobs retain their 5- and 15-minute limits. Hosted queueing has no guaranteed
completion time. If a metadata check times out or has an API failure, first check
the full source run. Once that full run passes, rerun the failed metadata workflow
with all jobs. This rechecks existing evidence without repeating product tests;
do not edit the PR to manufacture recovery or count the failed check as success.
No external result cache, write token or dispatch service is needed.

Metadata checks have fixed job names so GitHub's latest suite still reports
required `test`. Their concurrency group is separate from full validation: an
edit cannot cancel a real test run. Code changes and base edits always run the
full macOS suite. Draft-ready transitions do not repeat tests. Metadata receipt
runs (and historical ignored receipts) are excluded by the shared selector;
review and merge gates continue to require actual full validation. Advisory
review reports unstable/unavailable CI evidence as held and continues. Use a
full workflow rerun for current-context infrastructure recovery so all required
jobs are present in the selected attempt.

Action runtimes are separate from the Node version used by project commands.
Keep project Node pinned unless a separate compatibility change is justified.
Action upgrades use reviewed immutable SHAs and preserve credential handling and
permissions. Disable implicit package-manager caching; test workflows explicitly
retain `cache: npm`, while Pages has no package-manager cache. Check composite
Actions' nested runtimes as well as direct uses, and inspect fresh logs for removed
runtime warnings rather than treating a green result alone as proof.
