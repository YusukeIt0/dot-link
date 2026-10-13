#!/bin/bash
# Install the current stable Mac release. Uses only tools included with macOS.
# Keep the entry point safe when streamed into bash: execute only after parsing
# the entire function and its closing invocation.
dotlink_install() (
  set -eu
  # Use the first macOS preferred language, as the Mac app does. Add future
  # supported languages here and translations below; English is the fallback.
  dotlink_preferred="$(defaults read -g AppleLanguages 2>/dev/null | sed -n '2{s/[ ",]//g;p;}' || true)"
  case "$dotlink_preferred" in ja|ja-*) dotlink_language=ja ;; *) dotlink_language=en ;; esac
  message() {
    case "$dotlink_language:$1" in
      ja:platform) echo 'Apple Silicon搭載のMacが必要です。' ;;
      ja:os) echo 'macOS 13以降が必要です。' ;;
      ja:existing) echo 'Dot Linkは導入済みです。アプリの「アップデートを確認」を使ってください。' ;;
      ja:latest) echo 'Dot Linkの最新の正式版を確認しています…' ;;
      ja:release) echo '最新の正式Mac版を確認できませんでした。' ;;
      ja:asset) echo '最新版のApple Silicon用ZIPを一意に確認できませんでした。' ;;
      ja:url) echo '配布ファイルの取得先を確認できませんでした。' ;;
      ja:checksum) echo '配布ファイルのSHA-256を確認できませんでした。' ;;
      ja:download) echo '%s をダウンロードしています…' ;;
      ja:identity) echo '配布ファイル内のアプリがDot Linkではありません。' ;;
      ja:race) echo '導入先にアプリが作成されたため停止しました。既存アプリは置き換えていません。' ;;
      ja:installed) echo '%s を導入しました。Dot Linkを開きます…' ;;
      *:platform) echo 'An Apple Silicon Mac is required.' ;;
      *:os) echo 'macOS 13 or later is required.' ;;
      *:existing) echo 'Dot Link is already present. Use Check for updates in the app.' ;;
      *:latest) echo 'Finding the latest stable Dot Link release…' ;;
      *:release) echo 'The latest stable Mac release could not be verified.' ;;
      *:asset) echo 'Expected one Apple Silicon ZIP in the latest release.' ;;
      *:url) echo 'Unexpected download location.' ;;
      *:checksum) echo 'The release SHA-256 checksum is missing or invalid.' ;;
      *:download) echo 'Downloading %s…' ;;
      *:identity) echo 'The downloaded app is not identified as Dot Link.' ;;
      *:race) echo 'Destination appeared during installation; no app was replaced.' ;;
      *:installed) echo 'Installed %s. Opening Dot Link…' ;;
    esac
  }
  say() { local format; format="$(message "$1")"; shift; printf "$format\n" "$@"; }
  fail() { say "$@" >&2; exit 1; }
  [ "$(uname -s)" = Darwin ] || fail platform
  # hw.optional.arm64 also works from a Terminal running under Rosetta.
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] || fail platform
  dotlink_os="$(sw_vers -productVersion)"
  [ "${dotlink_os%%.*}" -ge 13 ] || fail os
  dotlink_destination="$HOME/Applications/Dot Link.app"
  if [ -e "$dotlink_destination" ] || [ -L "$dotlink_destination" ]; then
    fail existing
  fi
  dotlink_stage="$(mktemp -d "${TMPDIR:-/tmp}/dot-link-install.XXXXXX")"
  trap 'rm -rf "$dotlink_stage"' EXIT
  cd "$dotlink_stage"
  fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$@"; }
  field() { plutil -extract "$1" raw -expect "$2" -o - release.json; }
  say latest
  fetch --output release.json 'https://api.github.com/repos/YusukeIt0/dot-link/releases/latest'
  [ "$(field draft bool)" = false ] || fail release
  [ "$(field prerelease bool)" = false ] || fail release
  dotlink_tag="$(field tag_name string)"
  case "$dotlink_tag" in mac-v*) ;; *) fail release ;; esac
  dotlink_index=0
  dotlink_matches=0
  while dotlink_name="$(field "assets.$dotlink_index.name" string 2>/dev/null)"; do
    case "$dotlink_name" in
      Dot-Link-*-arm64.zip)
        dotlink_url="$(field "assets.$dotlink_index.browser_download_url" string)"
        dotlink_digest="$(field "assets.$dotlink_index.digest" string 2>/dev/null)" || fail checksum
        dotlink_matches=$((dotlink_matches + 1))
        ;;
    esac
    dotlink_index=$((dotlink_index + 1))
  done
  [ "$dotlink_matches" -eq 1 ] || fail asset
  case "$dotlink_url" in
    "https://github.com/YusukeIt0/dot-link/releases/download/$dotlink_tag/"*) ;;
    *) fail url ;;
  esac
  dotlink_hash="${dotlink_digest#sha256:}"
  [ "$dotlink_digest" != "$dotlink_hash" ] || fail checksum
  [ "${#dotlink_hash}" -eq 64 ] || fail checksum
  case "$dotlink_hash" in *[!0-9a-f]*) fail checksum ;; esac
  say download "$dotlink_tag"
  fetch --output Dot-Link.zip "$dotlink_url"
  printf '%s  %s\n' "$dotlink_hash" Dot-Link.zip | shasum -a 256 -c -
  ditto -x -k Dot-Link.zip unpacked
  codesign --verify --deep --strict 'unpacked/Dot Link.app'
  dotlink_bundle_id="$(plutil -extract CFBundleIdentifier raw -expect string -o - 'unpacked/Dot Link.app/Contents/Info.plist')"
  [ "$dotlink_bundle_id" = app.tripsurf.dotlink.mac ] || fail identity
  mkdir -p "$HOME/Applications"
  mv -n 'unpacked/Dot Link.app' "$dotlink_destination"
  [ ! -e 'unpacked/Dot Link.app' ] || fail race
  say installed "$dotlink_tag"
  open "$dotlink_destination"
)
dotlink_install
