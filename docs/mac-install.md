# Install Dot Link on a Mac / Macへのインストール

## English

Use an Apple Silicon Mac running macOS 13 or later. The Even companion needs this Mac app; installing the companion on your iPhone does not install it on your Mac.

### Download and install with Finder

1. Open [Download for Mac](https://github.com/YusukeIt0/dot-link/releases/latest) on your Mac. Scroll below the release notes to **Assets**. Download the file named `Dot-Link-…-arm64.zip`, not either **Source code** archive. You do not need a GitHub account.
2. Open the ZIP in Downloads. It expands to **Dot Link.app**.
3. In Finder, choose **Go → Home** and open your **Applications** folder. Create that folder in your home folder if it does not exist. Move **Dot Link.app** there. This is your user's Applications folder (`~/Applications`); the app's update support expects this location.
4. Open **Dot Link.app** from that folder. If macOS blocks it, read the next section.
5. Follow the app's preparation steps. The local speech model is about 488 MB. Continue with [setup](setup.md#english) for Tailscale and connecting your existing Dot.

If Dot Link is already installed, use **Check for updates** in the app. Do not uninstall it just to update: uninstalling also removes its settings and history.

### When macOS says Apple could not verify the app

The current Mac release is not Apple-notarized. macOS can report that Apple could not verify the app is free of malware and offer only **Done** and **Move to Trash**. This is not an installation-complete message.

If you want to allow the app after checking its source:

1. Choose **Done**.
2. Open **System Settings → Privacy & Security** and scroll to **Security**.
3. Check that the blocked app is **Dot Link.app**, then choose **Open Anyway**.
4. macOS may ask for your Mac login password or Touch ID. Authenticate in the macOS dialog yourself; do not send your password to an AI assistant or enter it on GitHub. If a further warning offers **Open**, select it to finish the confirmation.

Allowing this app is your decision. A matching download checksum or valid local signature is not Apple notarization or a guarantee that an app is safe. See [Apple's explanation of safely opening apps](https://support.apple.com/en-us/102445). If the warning instead says the app **will damage your computer** or **is damaged**, stop and investigate that different warning.

### Optional Terminal installation

You can ask an AI assistant to explain the commands before running them. This example downloads and installs **Mac 0.4.5/build 73**, a fixed release, using tools included with macOS. It does not automatically select future releases. Check [the release page](https://github.com/YusukeIt0/dot-link/releases/latest) before choosing a version.

The commands verify this release's published SHA-256 digest and bundle signature, then place the app in your user's Applications folder. They stop if an app is already present there. They do not configure Tailscale, connect Dot, download the speech model or grant macOS permissions. The final `open` can still show the warning described above.

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

The download and extracted files are staged in a temporary folder. This procedure does not remove quarantine attributes or disable Gatekeeper. Use the macOS confirmation flow above if a warning appears.

## 日本語

Apple Silicon搭載・macOS 13以降のMacが必要です。iPhoneのEvenアプリにDot Linkを入れただけではMac版はインストールされません。

### Finderでダウンロード・インストールする

1. Macで[Mac版の入手先](https://github.com/YusukeIt0/dot-link/releases/latest)を開きます。更新説明の下にある **Assets** までスクロールし、`Dot-Link-…-arm64.zip` をダウンロードします。**Source code** は選びません。GitHubアカウントは不要です。
2. ダウンロードしたZIPを開くと、**Dot Link.app** が展開されます。
3. Finderで **移動 → ホーム** を選び、その中の **アプリケーション（Applications）** フォルダへDot Link.appを移動します。フォルダがなければホーム内に作成します。配置先は自分のホーム内の `~/Applications` です。アプリの更新機能もこの場所を使います。
4. 移動先のDot Link.appを開きます。macOSに止められた場合は、次の手順へ進みます。
5. アプリの案内に沿って準備します。音声認識モデルは約488 MBです。Tailscaleと自分のDotへの接続は[導入ガイド](setup.md)に続きます。

既にインストール済みなら、アプリの「アップデートを確認」を使ってください。更新のためにアンインストールすると、設定や履歴も削除されます。

### 「マルウェアが含まれていないことを検証できませんでした」と表示されたら

現在のMac版はAppleの公証を受けていません。「完了」と「ゴミ箱に入れる」だけが表示される場合があります。この「完了」はインストール成功を意味しません。

入手元を確認し、このアプリの起動を許可すると判断した場合は、次の順に進みます。

1. 警告の **完了** を選びます。
2. **システム設定 → プライバシーとセキュリティ** を開き、下の **セキュリティ** までスクロールします。
3. ブロックされたアプリが **Dot Link.app** であることを確認し、**このまま開く** を選びます。
4. **Macのログインパスワード**、またはTouch IDによる確認を求められる場合があります。macOSの確認画面へ自分で入力・認証してください。AIとのチャットやGitHubへパスワードを送る操作ではありません。その後の警告に **開く** が表示されたら、内容を確認して選びます。

起動を許可するかは利用者が判断してください。ハッシュの一致や署名の整合性確認は、Appleによる公証や安全性の保証とは別です。[Appleの説明](https://support.apple.com/ja-jp/102445)も参照できます。「コンピュータに損害を与えます」「壊れている」など別の警告なら、この手順で進めず原因を確認してください。

### ターミナルから入れる場合

上の **Optional Terminal installation** のコマンドを使えます。実行前にAIへ内容の説明を求めても構いません。これは **Mac 0.4.5/build 73専用** の例で、将来の最新版を自動選択するものではありません。

公開ZIPの取得、公開ハッシュと署名の整合性確認、ホーム内のApplicationsへの配置、起動までを行います。既存アプリがある場合は停止します。Tailscale・Dot接続・音声認識モデルの準備やmacOSの許可は別途必要です。起動時に警告が出た場合は、上のmacOSの確認手順に進んでください。

ダウンロードと展開には一時フォルダを使います。隔離属性の削除やGatekeeperの無効化は行いません。
