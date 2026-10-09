#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
app_path="$PWD/.runtime/notification-menu/Dot Notification Lab.app"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources" "$PWD/.runtime/swift-module-cache"
xcrun swiftc -O -module-cache-path "$PWD/.runtime/swift-module-cache" \
  -framework AppKit -framework ApplicationServices -framework UserNotifications \
  native/NotificationMenu/DotStatus.swift native/NotificationMenu/main.swift -o "$app_path/Contents/MacOS/DotNotificationLab"
cp native/NotificationMenu/Info.plist "$app_path/Contents/Info.plist"
cp native/NotificationMenu/Setup.html "$app_path/Contents/Resources/Setup.html"
codesign --force --sign - --identifier local.even-g2-dot.notification-lab "$app_path"
printf '%s\n' "$app_path"
