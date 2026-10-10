#!/bin/sh
set -eu
mkdir -p .runtime/notification-structure-test .runtime/swift-module-cache
xcrun swiftc -module-cache-path .runtime/swift-module-cache native/DotLinkSetup/NotificationStructureProbe.swift tests/notification-structure-probe.swift -o .runtime/notification-structure-test/structure
.runtime/notification-structure-test/structure
xcrun swiftc -module-cache-path .runtime/swift-module-cache native/DotLinkSetup/NotificationReader.swift tests/notification-reader.swift -o .runtime/notification-structure-test/reader
.runtime/notification-structure-test/reader
xcrun swiftc -module-cache-path .runtime/swift-module-cache native/DotLinkSetup/NotificationReader.swift native/DotLinkSetup/NotificationForwarder.swift tests/notification-forwarder.swift -o .runtime/notification-structure-test/forwarder
.runtime/notification-structure-test/forwarder
