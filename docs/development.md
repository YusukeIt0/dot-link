# Development

## Tests

Use Node.js 22.18.0 or later; the packaged runtime is pinned in `scripts/mac-runtime-manifest.json`.

```sh
npm ci
npm test
npm run test:http
npm run build
sh scripts/test-notification-native.sh
```

Pushes and pull requests run these checks in GitHub Actions. Passing checks do not publish an application automatically. Only a tested release updates installed clients.

For the standalone introduction page, see [page maintenance and deployment](introduction-page.md).

For Even application state ownership and diagnosis, see [Even runtime ownership](even-runtime.md).

## Build the Mac app

Apple Silicon macOS, Xcode Command Line Tools, Python 3 and CMake are required.

```sh
python3 scripts/prepare-mac-runtime.py
node scripts/prepare-sparkle.mjs
node scripts/test-mac-update-driver.mjs
node scripts/build-mac-app.mjs
```

Output: `.runtime/mac-app/Dot Link.app`. Runtime downloads and Sparkle are pinned by version and SHA-256. No speech model, account credential, pairing, or conversation data is included. The speech model downloads during initial setup.

The app uses one public update feed at `https://raw.githubusercontent.com/YusukeIt0/dot-link/main/updates/mac/appcast.xml`. Release ZIPs are downloaded from this repository's public GitHub Releases. Users need no GitHub account, token, or development-channel setting.

### Manual update behavior

Choosing **Update** explicitly permits interrupting the connection and conversation in progress. After Sparkle verifies the download, the Mac app uses `update-prepare-manual` to journal the prior running/paused state, back up the app, and stop its owned services through the normal lifecycle. It does not wait for a device long-poll, transcription, or pending reply to become idle. Pairing, credentials, and persisted messages are retained; unsent speech may need to be repeated. A stopped relay remains stopped after relaunch, while a running relay is restored and health-checked.

The automatic path retains its idle checks; automatic updates remain disabled. Manual approval does not bypass app verification, service ownership checks, service termination, or recovery.

If preparation fails, **Retry update** reuses the verified installer while Dot Link stays open. A failed rollback exposes **Retry recovery** before another installation attempt. Quitting with a retained installer requires explicit confirmation that the download will be discarded. Sparkle's ready-to-install `dismiss` choice is not a safe cache operation: it can install on application exit before service preparation. See the [Sparkle user driver contract](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUserDriver.html).

For changes to this path, run `node --test tests/app-update.test.mjs tests/app-lifecycle.test.mjs` and `node scripts/test-mac-update-driver.mjs` (requires macOS AppKit access). These fixture checks do not establish physical update success. Before merge, test a configured Mac using a PR-commit build as the **starting updater** and a known signed target. An existing official release can be reused by giving the starting Beta a lower test-only build number; record this metadata override and leave the signed target/feed unchanged. Updating an old production app to the PR build still runs the old updater and does not validate this change.

Record the source commit, starting/target build identities, pairing/settings comparison, and outcomes for: connected idle, interrupted speech/transcription/reply, initially paused, preparation failure and retained-download retry, install failure and recovery, and quit while a verified installer is retained. Keep physical observations separate from injected failures and fixture results.

## Maintainer release

The maintainer needs authenticated `gh`, write access to this repository, and the existing Ed25519 signing key at `.runtime/update-signing/ed25519.key` with mode 600. This key is never included in a build, commit, or workflow. Contributors can build and test without the release key; only the maintainer signs official updates.

1. Update `CFBundleShortVersionString` and increase `CFBundleVersion` in `native/DotLinkSetup/Info.plist`.
2. Run tests, the native driver test, and the Mac build above. Inspect the app and changes. Push the matching source to `main`.
3. Write release notes to a local text file and run:

```sh
node scripts/release-mac-update.mjs '.runtime/mac-app/Dot Link.app' /path/to/release-notes.txt
```

4. Commit and push the generated `updates/mac/appcast.xml`. This enables client discovery of the signed release.
5. Fetch the public feed and ZIP without authentication, verify signatures, and check the update in the app. A failed network request must never be reported as “up to date.”

The release helper packages the app, verifies its signature, signs the ZIP, uploads a release, and signs the feed. The release points to the current public `main` commit. Do not publish mismatched source and binaries. Keep release signing local; do not put personal credentials into GitHub Actions to make installation work.

## Even companion

```sh
npm run package:beta
```

Work-branch validation builds show `Beta` beside the numeric app version. Use `npm run build` and `node scripts/package-beta.mjs` for those builds; the packager requires clean matching source and records its commit. Keep package ID and pairing identity stable, and increment the numeric version when a new upload requires it.

Package code merged into main with `npm run package:release` (which runs `build:release` and the shared asset/secret/SDK checks), without the Beta marker and without opt-in diagnostics. The version update must also be merged before packaging the main release. Private storage in Even Hub before review does not make a main release a Beta. Upload authorization does not authorize review submission or publication.

Independent defects discovered during the refactor may use a child fix branch and PR targeting the parent branch. Verify the fix before integrating it and preserve the parent acceptance criteria. Keep one overall outcome until automated checks, review and affected physical verification are complete. Main merge requires explicit maintainer instruction.

Reuse an uploaded build when it can answer the verification question; upload a new build when changed code requires it, within the authorized scope.

Even Hub publication is separate from Mac Releases. The internal package IDs remain stable for compatibility. Do not rename an installed data directory or recreate pairing when changing a display name.

## Repository rename compatibility

The repository is `YusukeIt0/dot-link` (formerly `dot-link-app`). The signed feed and future release enclosures intentionally use the `dot-link-app` download alias, which GitHub redirects to `dot-link`. Installed 0.2.21 clients restrict downloads to that original path. `downloadRepository` keeps publisher and client URL validation consistent; do not reuse the old name or remove this compatibility without a client migration. New builds use the canonical `dot-link` feed URL. Existing signed releases are unchanged.

## Operations and diagnostics

Use the Mac app's pause, resume, quit and update controls for normal operation; see the [user guide](setup.md#pause-quit-and-uninstall). Dot Link owns its launchd jobs and must not change unrelated jobs or network settings. Data, credentials, models, history and pairing live outside the app bundle.

Updates retain the data directory and paused state. Before installation, the app waits for recent Even activity and pending requests, records a recovery journal, and backs up the app and service configuration. Backups are retained; automatic rollback of an app that cannot launch is not implemented.

For source-based diagnostics, run `node scripts/setup.mjs status --voice-only` from the installation directory. Do not start another relay on the same ports. Runtime files may contain credentials: never attach the whole `.runtime` directory to an issue. For iPhone layout investigation, see [viewport diagnostics](viewport-diagnostics.md).


## Parent and child PR review

For a cohesive change split into substantial dependent steps, track the outcome in a parent issue and integration branch, with native sub-issues and child PRs targeting that branch. Define the ownership and dependency order first. Update each dependent child from the integrated parent before starting its work; small fixes do not need this hierarchy. Keep acceptance evidence in the issues/PRs, not a duplicate backlog.

Automated review executes helpers from trusted main. A child review pins its target branch and commit and supplies the exact main-to-base delta as read-only context before the PR diff. No reviewed base/head code is checked out or executed by the review job. Large base deltas stop preparation with a Needs a smaller scope result rather than silently omitting context. Moving the base or retargeting the PR invalidates the receipt. The child gate also verifies that the exact tested head contains the current parent commit (ahead or identical, with that parent as merge base). If the parent has advanced or a new target is not contained in the child, update the child and rerun CI/review. PR CI must also record the current parent ref/SHA; otherwise use the exact-head push CI, whose tree already contains the current parent. A run against an unrelated old target cannot qualify.

The normal gate remains `node scripts/check-review-before-merge.mjs <PR>` for main. For child integration, explicitly name the intended parent:

```sh
node scripts/check-review-before-merge.mjs <PR> --base refactor/even-state-coordination
```

Both paths require completed intake/review/report jobs, current review inputs, clean mergeability and passing branch-required CI. The child CI lookup supports in-repository heads and PR runs whose API metadata identifies the PR; fork child PRs with missing run association remain NOT READY. A child target may have no branch-protection requirements; the child gate additionally requires the completed product CI workflow and its test job for the exact head, even in that case. Read the findings; READY is not merge authorization. Integrate children in dependency order, then verify the combined parent with automated checks, review and the affected physical flows. Give device testers the exact build, starting state, numbered actions, expected results and requested observations. Main merge, upload/distribution, review submission and publication retain separate authorization stages.

When automation or repository settings conflict with this workflow, record the mismatch and agree on a meaningful workflow change before proceeding. A skipped review is not a completed review. For existing parent branches that predate a workflow update, dispatch the review from main (`gh workflow run claude-review.yml --ref main -f item_number=<PR>`) so the updated workflow runs.
