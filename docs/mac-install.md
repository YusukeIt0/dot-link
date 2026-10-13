# Install Dot Link on your Mac

**English** · [日本語](mac-install.ja.md)

You need an **Apple Silicon Mac with macOS 13 or later**.

| Method | Choose this if… |
| --- | --- |
| **Terminal — recommended** | You want the download, integrity checks and correct app placement handled together. Follow the steps below. |
| [Finder — manual ZIP installation](mac-install-finder.md) | You prefer downloading and moving the app yourself. |

Both methods install **the same Mac app**. There is no separate CLI edition.

## 1. Open Terminal

Open **Terminal** from Spotlight. You can ask an AI assistant to explain the commands before running them.

## 2. Copy and run the commands

This installs **Mac 0.4.5/build 73**. It checks the published download checksum and app signature, then places the app in **your Home folder’s Applications** (`~/Applications`). If Dot Link is already there, it stops; use **Check for updates** in the app.

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

This example is pinned to the version above; it does not automatically select future releases. The temporary download folder remains afterward. Integrity checks are not Apple notarization or a safety guarantee.

## 3. Open and prepare the app

Dot Link opens after installation. If macOS blocks it, follow [the first-launch warning steps](mac-install-finder.md#3-if-macos-blocks-the-first-launch), including the Mac password/Touch ID confirmation. The commands do not remove quarantine attributes or disable Gatekeeper.

Choose **Prepare this Mac**. About **490 MB** of speech data is downloaded. When **Connect your existing Dot** appears, Mac preparation is complete. Continue with [Dot connection setup](dot-setup.md) and [iPhone pairing](setup.md#english); the commands do not configure these accounts or grant their permissions.
