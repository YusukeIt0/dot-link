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

This downloads the **latest stable release at the time you run it**. It checks that the download matches GitHub’s published checksum, verifies the app’s internal signature consistency and bundle identifier, then places the app in **your Home folder’s Applications** (`~/Applications`). If Dot Link is already there, it stops; use **Check for updates** in the app.

```sh
curl -fsS https://raw.githubusercontent.com/YusukeIt0/dot-link/main/install.sh | /bin/bash
```

No version number or filename is needed. You can [read the installer](../install.sh) before running it. These checks detect a mismatched download or app bundle; they do not independently authenticate the publisher or provide Apple notarization.

The installer and Mac app start in Japanese when Japanese is the Mac’s preferred language; otherwise they use English.

## 3. Open and prepare the app

Dot Link opens after installation. If macOS blocks it, follow [the first-launch warning steps](mac-install-finder.md#3-if-macos-blocks-the-first-launch), including the Mac password/Touch ID confirmation. The commands do not remove quarantine attributes or disable Gatekeeper.

Choose **Prepare this Mac**. About **490 MB** of speech data is downloaded. When **Connect your existing Dot** appears, Mac preparation is complete. Continue with [Dot connection setup](dot-setup.md) and [iPhone pairing](setup.md#english); the commands do not configure these accounts or grant their permissions.
