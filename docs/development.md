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

Ordinary builds show `Beta` beside the numeric app version. `package:beta` produces `dot-link-<version>-beta.ehpk` and a receipt containing the channel and source commit. Packaging requires a clean worktree and matching build metadata, so commit changes before building the physical-test candidate. The numeric manifest version remains compatible with Even Hub; increment it for a new upload when required.

Only an explicitly authorized public-release step uses `npm run build:release` to omit the Beta label. This command builds assets; it does not upload or publish them. The Beta packager rejects release-mode assets. Determine the currently public version from the actual Even Hub publication record, not the highest local or Beta version.

Keep the refactor in one work branch and PR until the whole scope, automated checks/reviews, and affected physical verification are complete. Intermediate commits are checkpoints. Merge requires explicit maintainer instruction; build, upload, submission, and publication are separate stages.

Even Hub publication is separate from Mac Releases. The internal package IDs remain stable for compatibility. Do not rename an installed data directory or recreate pairing when changing a display name.

## Repository rename compatibility

The repository is `YusukeIt0/dot-link` (formerly `dot-link-app`). The signed feed and future release enclosures intentionally use the `dot-link-app` download alias, which GitHub redirects to `dot-link`. Installed 0.2.21 clients restrict downloads to that original path. `downloadRepository` keeps publisher and client URL validation consistent; do not reuse the old name or remove this compatibility without a client migration. New builds use the canonical `dot-link` feed URL. Existing signed releases are unchanged.

## Operations and diagnostics

Use the Mac app's pause, resume, quit and update controls for normal operation; see the [user guide](setup.md#pause-quit-and-uninstall). Dot Link owns its launchd jobs and must not change unrelated jobs or network settings. Data, credentials, models, history and pairing live outside the app bundle.

Updates retain the data directory and paused state. Before installation, the app waits for recent Even activity and pending requests, records a recovery journal, and backs up the app and service configuration. Backups are retained; automatic rollback of an app that cannot launch is not implemented.

For source-based diagnostics, run `node scripts/setup.mjs status --voice-only` from the installation directory. Do not start another relay on the same ports. Runtime files may contain credentials: never attach the whole `.runtime` directory to an issue. For iPhone layout investigation, see [viewport diagnostics](viewport-diagnostics.md).
