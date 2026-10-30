#!/bin/sh
# Same suite for PR/main and pre-PR branches; native tests always run on macOS.
set -eu
npm ci
npm test
npm run test:http
npm run build
sh scripts/test-notification-native.sh
sh scripts/test-setup-native.sh
