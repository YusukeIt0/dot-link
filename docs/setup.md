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

- 設定の**自動更新**をオンにすると、公開された新しい版を確認し、Evenを使っていない間に更新します。
- **アップデートを確認**から手動でも更新できます。
- 更新の確認・ダウンロード・検証・適用の状態を表示します。「Evenを閉じると更新を適用します」と表示されたら、Even側のDot Linkを終了してください。
- アプリ更新にGitHubアカウントやキーは不要です。OpenAI接続用の認証情報とは別の話です。

## 停止と終了

ウィンドウを閉じると常駐を続けます。一時停止は中継と通知を停止し、アプリを残します。「Dot Linkを終了」は中継・通知・常駐を終了します。再度アプリを開くと保存済みの設定で再開します。

## English

Download the Mac ZIP, place Dot Link.app in your user's Applications folder, and open it. Follow setup for Tailscale, the local speech model, and your own OpenAI tunnel. Keep the Mac awake and online; an iPhone alone is not enough.

[Open Dot Link in Even Hub](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink). On a computer, scan the page’s QR code with your iPhone. Alternatively, search for “Dot Link” in the Even Realities app. Install and open the companion before pairing. Create an Even connection code on the Mac, paste the entire code into the Even companion, and save it. Codes expire after two minutes and work once. Use **Automatic updates** or **Check for updates**; neither requires GitHub credentials. If the app says “Close Even to apply the update”, close Dot Link on the Even side. Closing the window keeps the app running. Pause stops the relay; Quit stops the app and relay. Existing settings and pairing are preserved during updates.
