#!/bin/sh
set -eu
mkdir -p .runtime/setup-failure-test .runtime/swift-module-cache
xcrun swiftc -module-cache-path .runtime/swift-module-cache native/DotLinkSetup/SetupFailure.swift tests/setup-failure.swift -o .runtime/setup-failure-test/presentation
.runtime/setup-failure-test/presentation
xcrun swiftc -module-cache-path .runtime/swift-module-cache native/DotLinkSetup/Localization.swift tests/mac-localization.swift -o .runtime/setup-failure-test/localization
.runtime/setup-failure-test/localization
xcrun swiftc -module-cache-path .runtime/swift-module-cache native/DotLinkSetup/Localization.swift native/DotLinkSetup/SetupFailure.swift native/DotLinkSetup/SupportStatus.swift tests/support-status.swift -o .runtime/setup-failure-test/support-status
.runtime/setup-failure-test/support-status
xcrun swiftc -module-cache-path .runtime/swift-module-cache -framework AppKit native/DotLinkSetup/WindowLayout.swift tests/window-layout.swift -o .runtime/setup-failure-test/window-layout
.runtime/setup-failure-test/window-layout
node tests/mac-quit-recovery.mjs
