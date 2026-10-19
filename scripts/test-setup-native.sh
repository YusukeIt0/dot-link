#!/bin/sh
set -eu
mkdir -p .runtime/setup-failure-test .runtime/swift-module-cache
xcrun swiftc -module-cache-path .runtime/swift-module-cache native/DotLinkSetup/SetupFailure.swift tests/setup-failure.swift -o .runtime/setup-failure-test/presentation
.runtime/setup-failure-test/presentation
