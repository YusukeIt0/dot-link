# Dot Link

**いつものDotを、Even G2で。**

**Your Dot, now on Even G2.**

[日本語](#日本語) · [English](#english)

[Even Hub](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink) · [Macアプリ / Mac app](https://github.com/YusukeIt0/dot-link/releases/latest)

## 日本語

Dot Linkは、いつものChatGPT DotとEven G2をつなぐオープンソースアプリです。声を出せない場所ではスマートフォンから入力し、音を出せない場面ではG2で返信を読めます。そのときの状況に合う方法で、Dotとやり取りできます。

### できること

| 項目 | 使い方 |
| --- | --- |
| **入力** | G2に話しかける、またはスマートフォンで文章を入力する |
| **返信** | G2のレンズ内で読む、または読み上げをオンにする |
| **メッセージ** | Dotからの自発メッセージや、Macの通知についての案内を受け取る |
| **表示** | 会話履歴を見返す、表示が消えるまでの時間を選ぶ |
| **操作** | 表示を戻すタップ操作や、顔を上げたときに反応する角度を調整する |

Macの通知共有は任意です。「Macの全通知をDotに共有」をオンにすると、読み取れる新着通知の送信者・見出し・本文をDotへ渡します。**何をいつ知らせるかはDotが判断します。** どんな通知を知らせてほしいかは、Dotに直接伝えてください。

### 位置共有（Even 0.2.23以降が必要）

Mac版0.4.0から、スマートフォンの位置情報をDotへ共有できます。Even側で「位置情報を共有する」をオンにすると、Dotが現在地を読み、場所に応じた案内をするか判断します。**初期状態はオフ**です。

**Mac版0.4.0以降とEven版0.2.23以降の両方が必要です。** Even側の対応版は一般公開待ちのため、現在のEven Hub配布版ではまだ位置共有を利用できません。

短時間のロック中の位置更新、G2への案内表示、共有オフ後の停止は開発テストで確認しています。長時間の移動、電池への影響、案内の有用性・頻度、再接続は引き続き検証中です。導入・更新時の接続は[Dotの設定](docs/dot-setup.md#optional-location-sharing-development-builds)を、データの扱いは[プライバシー説明](docs/privacy.md)を参照してください。

### 必要なもの

- **Even G2**と、Evenアプリ内のEven Hubからインストールした**Dot Link**
- **Apple Silicon Mac（macOS 13以降）**と**Dot LinkのMacアプリ**
- **iPhone**と**Evenアプリ**
- MacとiPhoneの両方で設定した**Tailscale**（機器同士を接続するために使います）
- **いつものChatGPT Dot**と、OpenAIのトンネル／プラグイン接続を利用できるアカウント。[Dotとの接続条件](docs/dot-setup.md)を確認してください。

**利用中はMacを起動し、ネットワークに接続しておく必要があります。** スリープ中やiPhone単体では利用できません。専用のMac miniを用意する必要はありません。

### 始め方

1. **Macアプリを入れる** — [Mac版をダウンロード](https://github.com/YusukeIt0/dot-link/releases/latest)し、展開した「Dot Link.app」を自分のホームフォルダのApplicationsへ移動します。アプリの案内に沿って、Tailscale・音声認識・Dotとの接続を準備します。
2. **Even側に入れる** — EvenアプリのEven Hubで「Dot Link」を検索してインストールします。[Even Hubで開く](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink)
3. **MacとEvenをつなぐ** — Macの「Evenを接続」でコードを発行し、Even側へ貼り付けて保存します。

詳しい手順は[導入ガイド](docs/setup.md)を参照してください。

### Mac 0.4.5とEven 0.2.27の改善

Mac 0.4.5では通知の権限設定を一つの画面から開けるようにし、Even 0.2.27の未読・既読表示に対応しました。Even 0.2.27には、会話履歴の復元、新着返信件数、返信待ちが長い場合の案内と消灯、G2右端の文字表示の改善を含みます。Even 0.2.27は一般公開待ちです。

### 更新と、知っておいてほしいこと

- **更新:** 現在、自動更新は一時停止中です。Macアプリの「アップデートを確認」から手動で更新できます。GitHubアカウントや更新用のキーは不要です。
- **通知の権限:** 更新後に通知を共有できない場合は、システム設定のアクセシビリティ内にあるDot Linkを一度削除し、インストール先のDot Link.appを追加し直してオンにしてください。
- **通知の対応範囲:** すべての通知形式や即時到着を保証するものではありません。通知元アプリへの返信操作には対応していません。
- **動作確認の範囲:** スリープ復帰・通信断・長時間利用・さまざまな利用環境での動作は、引き続き検証中です。
- **Macの起動確認:** Apple公証は未実施のため、初回起動にmacOS側の確認が必要な場合があります。配布する更新ファイルと更新情報には、改ざんを検知するための署名を付けています。

会話を中継するのは自分のMacです。開発者が共用する会話サーバーは設けていません。送信・保存する情報の詳細は[データの扱い](docs/privacy.md)を確認してください。

## English

Dot Link is an open-source app that brings your existing ChatGPT Dot to Even G2. When speaking aloud isn't an option, type on your phone. When listening to audio isn't an option, read the reply on G2. Choose the way to interact that fits the moment.

### What you can do

| Feature | How you use it |
| --- | --- |
| **Input** | Speak through G2 or type on your phone |
| **Replies** | Read replies on G2 or turn on read-aloud |
| **Messages** | Receive proactive messages from Dot and announcements about Mac notifications |
| **Display** | Browse conversation history and choose how long the display stays visible |
| **Controls** | Choose the tap gesture that restores the display and adjust the head-raise angle |

Mac notification sharing is optional. Turn on **Share all Mac notifications with Dot** to share visible sender names, headings and text from readable new notifications. **Dot decides what to announce and when.** Tell Dot directly which notifications you'd like to hear about.

### Location sharing (requires Even 0.2.23 or later)

Mac version 0.4.0 adds optional phone location sharing. Turn on **Share location** in the Even companion to let your Dot read the current location and decide whether to offer a location-based announcement. **Sharing starts off.**

**Requires Mac 0.4.0 or later and Even companion 0.2.23 or later.** The compatible Even companion is awaiting public release, so location sharing is not yet available with the version currently distributed through Even Hub.

Development testing has covered brief location updates while the phone is locked, an announcement displayed on G2, and stopping sharing after opt-out. Longer movement, battery impact, usefulness and frequency of announcements, and reconnection remain under evaluation. See [Dot setup](docs/dot-setup.md#optional-location-sharing-development-builds) and [data handling](docs/privacy.md).

### What you need

- **Even G2** and **Dot Link**, installed from Even Hub in the Even app
- An **Apple Silicon Mac running macOS 13 or later**, with the **Dot Link Mac app**
- An **iPhone** with the **Even app**
- **Tailscale** set up on both the Mac and iPhone to connect the devices
- **Your existing ChatGPT Dot**, with access to the required OpenAI tunnel/plugin features. Check the [Dot connection requirements](docs/dot-setup.md).

**Your Mac must remain awake and connected to the internet while you use Dot Link.** It does not work while the Mac is asleep or with an iPhone alone. A dedicated Mac mini is not required.

### Get started

1. **Set up the Mac app** — [Download for Mac](https://github.com/YusukeIt0/dot-link/releases/latest), unzip it, and move **Dot Link.app** to the Applications folder in your home folder. Follow the app's instructions to prepare Tailscale, speech recognition and the connection to your Dot.
2. **Install on the Even side** — Search for **Dot Link** in Even Hub in the Even app. [Open in Even Hub](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink).
3. **Connect Mac and Even** — Choose **Connect Even** in the Mac app, generate a code, and paste it into the Even companion to save the connection.

See the [setup guide](docs/setup.md) for the full steps.

### Improvements in Mac 0.4.5 and Even 0.2.27

Mac 0.4.5 opens notification permission settings through one screen and supports the unread/read indicators in Even 0.2.27. Even 0.2.27 also improves history restoration, new-reply counts, delayed-reply guidance and display timeout behavior, and text readability near the right edge of G2. Even 0.2.27 is awaiting public release.

### Updates and things to know

- **Updates:** Automatic updates are temporarily disabled. Use **Check for updates** in the Mac app to update manually. You do not need a GitHub account or an update key.
- **Notification permission:** If sharing stops after an update, remove Dot Link from the Accessibility list in System Settings, add the installed Dot Link.app again, and turn access on.
- **Notification support:** Not every notification format or immediate arrival is guaranteed. Replying in the source app is not supported.
- **Testing scope:** Recovery from sleep, connection loss, extended use and different user environments remain under testing.
- **First launch on Mac:** The app is not Apple-notarized, so macOS may ask for confirmation. Update files and the update feed are signed to detect tampering.

Your own Mac relays the conversation. There is no shared conversation server operated by the developer. See [Data handling](docs/privacy.md) for what is sent and stored.

## 開発者向け / For developers

Bug reports, questions and ideas are welcome. See [Contributing](CONTRIBUTING.md) for automatic issue/PR reviews and how to request another review.

不具合・疑問・アイデアの投稿とレビューの使い方は[貢献ガイド](CONTRIBUTING.md)を参照してください。

```sh
npm ci
npm test
npm run test:http
npm run build
```

Macアプリのビルドや技術的な仕組みは[開発ガイド](docs/development.md)へ。

For Mac build instructions and technical details, see the [development guide](docs/development.md).

## ライセンス / License

Dot Linkの独自コードは[MIT License](LICENSE)です。依存ソフトはそれぞれのライセンスに従います。[第三者ライセンス](docs/dependencies.md)を参照してください。OpenAI、Even Realities、Tailscaleの公式製品ではありません。

Dot Link's own code is licensed under the [MIT License](LICENSE). Dependencies retain their own licenses; see [third-party licenses](docs/dependencies.md). This is not an official product of OpenAI, Even Realities or Tailscale.
