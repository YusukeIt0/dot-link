# 導入と日常操作 / Setup

## Mac

1. [最新版](https://github.com/YusukeIt0/dot-link/releases/latest)のMac ZIPを取得して展開します。
2. Dot Link.appを自分のホームフォルダのApplicationsへ移動して開きます。
3. 表示される準備手順に沿って、Tailscale接続と音声認識モデルを用意します。初回は約488 MBのモデルを取得します。
4. 接続設定で、自分のOpenAIトンネル接続を設定します。詳細は[Dotとの連携](dot-setup.md)を参照してください。

既に使っているMacを更新する場合、接続ID・トンネル・ペアリングを作り直す必要はありません。

Macは起動・ネットワーク接続を維持してください。スリープ中は会話を中継できません。iPhone単体では動作しません。

## Even

[Dot LinkをEven Hubで開く](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink)。パソコンで開いた場合は、ページのQRコードをiPhoneで読み取ってください。Evenアプリの「Even Hub」で「Dot Link」を検索して開くこともできます。Dot Linkをインストールしてから、以下の接続手順へ進んでください。Mac版も別途必要です。

1. Macの「Evenを接続」から接続コードを発行します。
2. Even側にコード全体を貼り付けて保存します。コードは2分間・1回限りです。
3. 録音して、Dotからの返信を確認します。

## 更新

- **自動更新**は一時停止中のため、オフで操作できない表示になります。
- **アップデートを確認**から手動で更新してください。
- 更新の確認・ダウンロード・検証・適用の状態を表示します。「Evenを閉じると更新を適用します」と表示されたら、Even側のDot Linkを終了してください。
- アプリ更新にGitHubアカウントやキーは不要です。OpenAI接続用の認証情報とは別の話です。

## 通知の共有

通知設定の「権限設定」からアクセシビリティを開き、「＋」でインストール先のDot Link.appを追加してオンにしてください。「Macの全通知をDotに共有」を有効にすると、読み取れる新着通知の送信者・見出し・本文を既存Dotへ渡します。どんな通知を知らせてほしいかは、Dotに直接伝えてください。

更新後に通知を共有できない場合は、アクセシビリティ内にあるDot Linkを一度削除して追加し直してください。通知形式によっては読み取れず、Dotの判断・接続状態によって案内に時間がかかる場合があります。「一時停止」で通知の取り込みを止められます。

## アンインストール

アプリ内の「Dot Linkをアンインストール…」で、アプリ・音声認識モデル・接続設定・会話履歴をまとめてゴミ箱へ移します。設定を残す選択肢はありません。再び使うには初期設定が必要です。対象範囲は[データの扱い](privacy.md)を参照してください。

## 停止と終了

ウィンドウを閉じると常駐を続けます。一時停止は中継と通知を停止し、アプリを残します。「Dot Linkを終了」は中継・通知・常駐を終了します。再度アプリを開くと保存済みの設定で再開します。

## English

Download the Mac ZIP, place Dot Link.app in your user's Applications folder, and open it. Follow setup for Tailscale, the local speech model, and your own OpenAI tunnel. Keep the Mac awake and online; an iPhone alone is not enough.

[Open Dot Link in Even Hub](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink). On a computer, scan the page’s QR code with your iPhone. Alternatively, search for “Dot Link” in the Even Realities app. Install and open the companion before pairing. Create an Even connection code on the Mac, paste the entire code into the Even companion, and save it. Codes expire after two minutes and work once. Automatic updates are temporarily disabled. Use **Check for updates**; GitHub credentials are not required. If the app says “Close Even to apply the update”, close Dot Link on the Even side. Closing the window keeps the app running. Pause stops the relay; Quit stops the app and relay. Existing settings and pairing are preserved during updates.

For notifications, click **Permissions**, open Accessibility, add the installed Dot Link.app with **+**, and turn access on. Enable **Share all Mac notifications with Dot** to share visible sender names, headings and text from readable new notifications. Tell Dot which notifications you want to hear about. Some notification formats may not be readable, and announcements may be delayed. If sharing stops after an update, remove Dot Link from the Accessibility list and add it again. Pause stops notification collection.

**Uninstall Dot Link…** moves the app, speech model, connection settings and conversation history to Trash. There is no option to keep settings. You will need to set up the app again to use it. See [Data handling](privacy.md) for the deletion scope.
