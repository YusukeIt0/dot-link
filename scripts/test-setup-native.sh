#!/bin/sh
set -eu
mkdir -p .runtime/setup-failure-test .runtime/swift-module-cache
xcrun swiftc -module-cache-path .runtime/swift-module-cache native/DotLinkSetup/SetupFailure.swift tests/setup-failure.swift -o .runtime/setup-failure-test/presentation
.runtime/setup-failure-test/presentation
xcrun swiftc -module-cache-path .runtime/swift-module-cache native/DotLinkSetup/Localization.swift tests/mac-localization.swift -o .runtime/setup-failure-test/localization
.runtime/setup-failure-test/localization
