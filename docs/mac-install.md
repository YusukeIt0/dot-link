# Install Dot Link on your Mac

**English** · [日本語](mac-install.ja.md)

You need an **Apple Silicon Mac with macOS 13 or later**.

## 1. Download the app

Open **[Download for Mac](https://github.com/YusukeIt0/dot-link/releases/latest)** → scroll to **Assets** → choose **`Dot-Link-…-arm64.zip`**.

Do not choose either **Source code** file. No GitHub account is required.

## 2. Move the app

1. Open the ZIP in **Downloads**. You will see **Dot Link.app**.
2. In Finder, choose **Go → Home → Applications**. Create an **Applications** folder inside Home if it is missing.
3. Move **Dot Link.app** into that folder, then open it.

Use **your Home folder’s Applications** (`~/Applications`). Dot Link’s update feature expects this location.

## 3. If macOS blocks the first launch

The current release is not Apple-notarized. If Apple says it could not verify that the app is free of malware, use the steps below **only if you have decided to trust this download**.

| What you see | What to do |
| --- | --- |
| Warning with only **Done** / **Move to Trash** | Choose **Done**. |
| **System Settings → Privacy & Security** | Scroll down to **Security**. Next to **Dot Link.app**, choose **Open Anyway**. |
| Password or Touch ID prompt | Authenticate **in the Mac dialog** using your Mac login password or Touch ID. |
| A further warning with **Open** | Choose **Open**. |

Do not repeatedly double-click the app after choosing **Done**; continue in **System Settings**. Do not send your password to an AI assistant or enter it on GitHub. If the warning instead says the app **will damage your computer** or **is damaged**, stop: that is a different warning. [Apple’s official instructions](https://support.apple.com/en-us/102445)

## 4. Prepare this Mac

In Dot Link, choose **Prepare this Mac**. The app downloads about **490 MB** of speech data, then advances to **Connect your existing Dot**.

**The app is now installed.** Continue with [Dot connection setup](dot-setup.md) and [iPhone pairing](setup.md#english).

---

[Prefer Terminal commands?](mac-install-cli.md) · Already installed? Use **Check for updates** in the app; uninstalling removes settings and history.
