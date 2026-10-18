#!/bin/sh
# Run outside credentialed jobs. No auto-fixes or remote repository inspection.
set -eu
tools_dir=$(mktemp -d)
trap 'rm -rf "$tools_dir"' EXIT HUP INT TERM
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin_arm64; digest=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
  Linux-x86_64) platform=linux_amd64; digest=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  *) echo 'Unsupported checker host; use macOS arm64 or Linux x86_64.' >&2; exit 1 ;;
esac
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_${platform}.tar.gz" \
  -o "$tools_dir/actionlint.tar.gz"
printf '%s  %s\n' "$digest" "$tools_dir/actionlint.tar.gz" | shasum -a 256 -c -
tar -xzf "$tools_dir/actionlint.tar.gz" -C "$tools_dir" actionlint
python3 -m venv "$tools_dir/python"
"$tools_dir/python/bin/pip" --disable-pip-version-check --quiet install 'zizmor==1.31.1' 'PyYAML==6.0.3'
PYTHONDONTWRITEBYTECODE=1 "$tools_dir/python/bin/python" -m unittest discover -s tests -p 'workflow_queue_test.py'
PYTHONDONTWRITEBYTECODE=1 "$tools_dir/python/bin/python" scripts/check-workflow-queue.py
# actionlint 1.7.12 does not yet recognize GitHub's concurrency.queue.
# Suppress only this exact unsupported-key diagnostic; the check above validates
# its sole permitted location and complete concurrency policy. All other actionlint
# diagnostics still fail. Remove this exception when upstream supports queue.
"$tools_dir/actionlint" -ignore '^unexpected key "queue" for "concurrency" section\. expected one of "cancel-in-progress", "group"$'
"$tools_dir/python/bin/zizmor" --offline .github/workflows
