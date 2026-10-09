# 導入と日常操作 / Setup

## Mac

1. [最新版](https://github.com/YusukeIt0/dot-link-app/releases/latest)のMac ZIPを取得して展開します。
2. Dot Link.appを自分のホームフォルダのApplicationsへ移動して開きます。
3. 表示される準備手順に沿って、Tailscale接続と音声認識モデルを用意します。初回は約488 MBのモデルを取得します。
4. 接続設定で、自分のOpenAIトンネル接続を設定します。詳細は[Dotとの連携](dot-setup.md)を参照してください。

既に使っているMacを更新する場合、接続ID・トンネル・ペアリングを作り直す必要はありません。

## Even

Even側のDot Linkパッケージを利用できることが前提です。Even Hubの一般公開はまだです。

1. Macの「Evenを接続」から接続コードを発行します。
2. Even側にコード全体を貼り付けて保存します。コードは2分間・1回限りです。
3. 録音して、Dotからの返信を確認します。

## 更新

- 設定の**自動更新**をオンにすると、公開された新しい版を確認し、Evenを使っていない間に更新します。
- **アップデートを確認**から手動でも更新できます。
- 「最新バージョンです」「新しいバージョンがあります」「更新中」「確認できませんでした」で状態を表示します。
- アプリ更新にGitHubアカウントやキーは不要です。OpenAI接続用の認証情報とは別の話です。

## 停止と終了

ウィンドウを閉じると常駐を続けます。一時停止は中継と通知を停止し、アプリを残します。「Dot Linkを終了」は中継・通知・常駐を終了します。再度アプリを開くと保存済みの設定で再開します。

## English

Download the Mac ZIP, place Dot Link.app in your user's Applications folder, and open it. Follow setup for Tailscale, the local speech model, and your own OpenAI tunnel. On the Mac, create an Even connection code; paste the entire code into the Even companion and save it. Codes expire after two minutes and work once.

The Even companion is not yet generally available in Even Hub. Mac download availability does not imply Even Hub approval. Use **Automatic updates** or **Check for updates**; neither requires GitHub credentials. Closing the window keeps the app running. Pause stops the relay; Quit stops the app and relay. Existing settings and pairing are preserved during updates.
