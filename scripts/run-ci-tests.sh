#!/bin/sh
# Full product suite selected by run-ci-plan.mjs; native tests always run on macOS.
set -eu
npm ci
npm test
npm run test:http
npm run build
sh scripts/test-notification-native.sh
sh scripts/test-setup-native.sh
