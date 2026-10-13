# Terminal installation / ターミナルでの導入

[Finder instructions](mac-install.md) · [Finderでの手順](mac-install.ja.md)

## English

This optional example installs **Mac 0.4.5/build 73** on Apple Silicon/macOS 13+. It is a fixed version, not an automatic latest-version installer. Check [the current release](https://github.com/YusukeIt0/dot-link/releases/latest) before choosing it. You can ask an AI assistant to explain the commands before running them.

The commands download the public ZIP, check its published SHA-256 digest and bundle signature, and place it in `~/Applications`. They stop if Dot Link is already there. They do not configure Dot/Tailscale, grant permissions or download the speech model. A matching checksum and valid local signature do not establish Apple notarization or guarantee safety.

```sh
(
  set -eu
  dotlink_destination="$HOME/Applications/Dot Link.app"
  if [ -e "$dotlink_destination" ] || [ -L "$dotlink_destination" ]; then
    echo 'Dot Link is already present. Use Check for updates in the app.' >&2
    exit 1
  fi
  dotlink_stage="$(mktemp -d "${TMPDIR:-/tmp}/dot-link-install.XXXXXX")"
  cd "$dotlink_stage"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output Dot-Link.zip \
    'https://github.com/YusukeIt0/dot-link/releases/download/mac-v0.4.5-73/Dot-Link-0.4.5-73-arm64.zip'
  printf '%s  %s\n' \
    '82f9a0cdd9a578d4d49b1a01640ee0491d25e74eee75e9524bea99f8df7518c3' \
    'Dot-Link.zip' | shasum -a 256 -c -
  ditto -x -k Dot-Link.zip unpacked
  codesign --verify --deep --strict 'unpacked/Dot Link.app'
  mkdir -p "$HOME/Applications"
  mv -n 'unpacked/Dot Link.app' "$dotlink_destination"
  if [ -e 'unpacked/Dot Link.app' ]; then
    echo 'Destination appeared during installation; no app was replaced.' >&2
    exit 1
  fi
  open "$dotlink_destination"
)
```

The temporary download folder remains after execution. This procedure does not remove quarantine attributes or disable Gatekeeper. If macOS blocks launch, follow [the first-launch steps](mac-install.md#3-if-macos-blocks-the-first-launch). Continue preparation in the app.

## 日本語

上のコマンドは **Mac 0.4.5/build 73専用**です。Apple Silicon・macOS 13以降で使えます。将来の最新版を自動取得するものではないため、[現在の公開版](https://github.com/YusukeIt0/dot-link/releases/latest)を確認してから選んでください。実行前にAIへ内容の説明を求めても構いません。

公開ZIPの取得 → 公開ハッシュと署名の整合性確認 → `~/Applications` への配置 → 起動を行います。既存アプリがある場合は停止します。Tailscale・Dot接続・権限・音声認識モデルの準備は別途必要です。ハッシュや署名の検証は、Appleの公証や安全性の保証とは別です。

作業用の一時フォルダは実行後も残ります。隔離属性の削除やGatekeeperの無効化は行いません。警告が出たら[初回起動の手順](mac-install.ja.md#3-初回の警告が出たら)へ進み、その後アプリ内でMacを準備してください。
