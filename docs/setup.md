# 導入と日常操作 / Setup

## Mac

1. [最新版](https://github.com/YusukeIt0/dot-link/releases/latest)のMac ZIPを取得して展開します。
2. Dot Link.appを自分のホームフォルダのApplicationsへ移動して開きます。
3. 表示される準備手順に沿って、Tailscale接続と音声認識モデルを用意します。初回は約488 MBのモデルを取得します。
4. 接続設定で、自分のOpenAIトンネル接続を設定します。詳細は[Dotとの連携](dot-setup.md)を参照してください。

既に使っているMacを更新する場合、トンネルID・トンネル・ペアリングを作り直す必要はありません。

Macは起動・ネットワーク接続を維持してください。スリープ中は会話を中継できません。iPhone単体では動作しません。

## Even

[Dot LinkをEven Hubで開く](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink)。パソコンで開いた場合は、ページのQRコードをiPhoneで読み取ってください。Evenアプリの「Even Hub」で「Dot Link」を検索して開くこともできます。Dot Linkをインストールしてから、以下の接続手順へ進んでください。Mac版も別途必要です。

Even側の設定は「位置情報の共有」「表示設定」「Macと接続 / 解除」の順です。Mac版をまだ入れていない場合は、一番下の「Macと接続 / 解除」で入手先URLをコピーし、Macのブラウザーで開いてインストールします。コピー成功時は「コピーしました」が約2.5秒表示されます。コピーできない環境では、表示されているURLをMacのブラウザーに入力してください。同じ欄で接続コードの入力・接続・解除まで行えます。iPhoneではApp Storeで「Tailscale」を検索してインストールし、Macで使ったものと同じアカウントでログインしてください。両方の端末を同じTailscaleネットワークに接続してから、接続コードを発行します。

1. Macの「Evenを接続」から接続コードを発行します。
2. Even側の「Macと接続 / 解除」の入力欄にコード全体を貼り付けて接続します。コードは2分間・1回限りです。
3. 録音して、Dotからの返信を確認します。

## 更新

- **自動更新**は一時停止中のため、オフで操作できない表示になります。
- **アップデートを確認**から手動で更新してください。
- 更新の確認・ダウンロード・検証・適用の状態を表示します。「Evenを閉じると更新を適用します」と表示されたら、Even側のDot Linkを終了してください。
- Mac 0.3.2以降は、Macの準備だけ済ませたDot未接続の状態でも更新できます。更新時はアプリが自動で終了・再起動します。0.3.0／0.3.1で、Dot未接続なのに上の待機表示が続く場合は、Dot Linkを終了し、最新版をダウンロードしてホームフォルダのApplications内のアプリだけを置き換えてください。アンインストールはせず、Application Support内の設定データを残してください。
- アプリ更新にGitHubアカウントやキーは不要です。OpenAI接続用の認証情報とは別の話です。

## 音声入力

Macの「音声入力」からサービスを選べます。標準のWhisper smallはMac内で無料で認識します。外部サービス（Soniox、ElevenLabs、Microsoft、OpenAI、AssemblyAI）を使う場合は、ご自身のAPIキーを保存してください。録音はMacから選択先へ直接送られ、各社のAPI料金・利用枠が適用されます。MicrosoftのみAzure Speechの接続先も必要です。画面下部の「接続先について」から公式の取得方法を参照できます。変更は次の音声入力から反映され、失敗時に別のサービスへ自動では切り替わりません。

キーチェーンの確認画面が表示されたら「常に許可」を選択してください。アプリ更新後に再許可が必要な場合があります。キーを変更する場合は「キーを削除」してから新しいキーを保存します。使用中サービスのキーを削除するとWhisperへ戻ります。

公開中のEven 0.2.14でも音声入力を利用できます。サービス名の表示や詳しいエラー案内はEven 0.2.19以降に含まれます。全6種類のサービス・モデル表示はEven 0.2.21が必要です。スマートフォンからの文字入力には音声認識サービスを使いません。

## 音声出力

Macの「音声出力」で、現在の読み上げ方式（iPhone）を確認できます。読み上げのON／OFFは、Evenアプリ内のDot Linkで切り替えます。外部の音声出力サービスはまだ選択できません。

## 通知の共有

通知設定の「権限設定」からアクセシビリティを開き、「＋」でインストール先のDot Link.appを追加してオンにしてください。「Macの全通知をDotに共有」を有効にすると、読み取れる新着通知の送信者・見出し・本文を既存Dotへ渡します。どんな通知を知らせてほしいかは、Dotに直接伝えてください。

更新後に通知を共有できない場合は、アクセシビリティ内にあるDot Linkを一度削除して追加し直してください。通知形式によっては読み取れず、Dotの判断・接続状態によって案内に時間がかかる場合があります。「一時停止」で通知の取り込みを止められます。

## アンインストール

アプリ内の「Dot Linkをアンインストール…」で、アプリ・音声認識モデル・接続設定・会話履歴をまとめてゴミ箱へ移します。設定を残す選択肢はありません。再び使うには初期設定が必要です。対象範囲は[データの扱い](privacy.md)を参照してください。

## 停止と終了

ウィンドウを閉じると常駐を続けます。一時停止は中継と通知を停止し、アプリを残します。「Dot Linkを終了」は中継・通知・常駐を終了します。再度アプリを開くと保存済みの設定で再開します。

## English

Download the Mac ZIP, place Dot Link.app in your user's Applications folder, and open it. Follow setup for Tailscale, the local speech model, and your own OpenAI tunnel. Keep the Mac awake and online; an iPhone alone is not enough.

[Open Dot Link in Even Hub](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink). On a computer, scan the page’s QR code with your iPhone. Alternatively, search for “Dot Link” in the Even Realities app. Install and open the companion before pairing. Create an Even connection code on the Mac, paste the entire code into Connect / disconnect your Mac in the Even companion, and connect. If you need the Mac app first, open Connect / disconnect your Mac below Location sharing and Display settings. Copy the GitHub download URL and open it in a browser on your Mac. A “Copied” notification appears for about 2.5 seconds after copying succeeds. If copying is unavailable, enter the displayed URL in your Mac browser. On your iPhone, search for Tailscale in the App Store, install it, and sign in with the same account used on your Mac. Connect both devices to the same Tailscale network before creating a pairing code. Codes expire after two minutes and work once. Automatic updates are temporarily disabled. Use **Check for updates**; GitHub credentials are not required. If the app says “Close Even to apply the update”, close Dot Link on the Even side. Closing the window keeps the app running. Pause stops the relay; Quit stops the app and relay. Existing settings and pairing are preserved during updates.

Mac 0.3.2 and later can update after initial Mac preparation, before connecting Dot. The app quits and relaunches automatically during installation. If 0.3.0 or 0.3.1 keeps waiting for Even to close even though Dot has never been connected, quit Dot Link, download the latest version and replace only the app in your home Applications folder. Do not uninstall or remove the settings in Application Support.

In **Speech input** on the Mac, choose free local Whisper small or save your own key for Soniox, ElevenLabs, Microsoft, OpenAI or AssemblyAI. Recordings go directly from your Mac to the selected service; its API charges and limits apply. Microsoft also requires your Azure Speech endpoint; see About the endpoint below the settings card. Changes take effect on the next recording, with no automatic fallback. Choose **Always Allow** when Keychain asks; an app update may require permission again. To replace a key, delete it first and save the new one. Deleting the active service key switches back to Whisper. Speech input also works with the published Even 0.2.14; provider labels and detailed error messages are included in Even 0.2.19 and later; labels for all six services and their models require Even 0.2.21. Typed messages do not use speech recognition.

For notifications, click **Permissions**, open Accessibility, add the installed Dot Link.app with **+**, and turn access on. Enable **Share all Mac notifications with Dot** to share visible sender names, headings and text from readable new notifications. Tell Dot which notifications you want to hear about. Some notification formats may not be readable, and announcements may be delayed. If sharing stops after an update, remove Dot Link from the Accessibility list and add it again. Pause stops notification collection.

**Uninstall Dot Link…** moves the app, speech model, connection settings and conversation history to Trash. There is no option to keep settings. You will need to set up the app again to use it. See [Data handling](privacy.md) for the deletion scope.

### Speech output

**Speech output** on the Mac shows the current method, iPhone. Turn read aloud on or off in Dot Link inside the Even app. External speech output services are not yet available.
