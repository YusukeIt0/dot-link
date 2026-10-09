# Dot Link

[Download for Mac](https://github.com/YusukeIt0/dot-link-app/releases/latest) · [日本語の導入ガイド](docs/setup.md) · [Build from source](docs/development.md)

いつものChatGPT DotとEven G2を、自分のMacでつなぐオープンソースアプリです。
An open-source Mac companion that connects your existing ChatGPT Dot with Even G2 through a relay you own.

## Download and updates / ダウンロードと更新

[Releases](https://github.com/YusukeIt0/dot-link-app/releases/latest)からMac用ZIPをダウンロードし、展開した**Dot Link.app**をユーザーの**Applications**フォルダへ入れて開いてください。

- **対応:** Apple Silicon Mac、macOS 13以降。
- **更新:** 設定の「自動更新」でオン／オフを選べます。「アップデートを確認」はいつでも使えます。GitHubへのログインや更新キーは不要です。
- **配布署名:** 更新ファイルと配信情報はEd25519で検証します。現在のMacアプリはアドホック署名で、Apple公証済みではありません。初回起動や通知権限にmacOS側の確認が必要な場合があります。

Download the Mac ZIP from Releases, move **Dot Link.app** to your user's **Applications** folder, and open it. Updates are public and require no GitHub account or token. Choose automatic updates or use **Check for updates**. This build is for Apple Silicon on macOS 13 or later and is not Apple-notarized.

## What you need / 必要なもの

- Even G2、Evenアプリ、Dot LinkのEven側パッケージ。**Even Hubでの一般公開はまだ行っていません。Mac版の公開だけでEven側へインストールされるわけではありません。**
- 自分の既存ChatGPT Dotと、利用可能なOpenAIのトンネル／プラグイン接続。対応する機能がアカウントに必要です。
- MacとiPhoneのTailscale接続。ログインと機器の許可は本人が行います。

You also need the Even companion (not yet generally available in Even Hub), your own existing ChatGPT Dot with access to the required OpenAI tunnel/plugin features, and Tailscale on your Mac and iPhone. A dedicated Mac mini is not required.

## Current capabilities / 現在の機能

- Macで音声認識し、既存Dotへ発話を届け、返信をEvenへ返します。Mac側に共有の会話サーバーや代替チャットモデルを追加しません。
- Macで発行した接続コードをEven側へ貼り付けます。接続設定を保存し、アプリ更新後も引き継ぎます。
- 自動更新はEvenの接続・処理が落ち着くまで待ちます。会話中に更新を強制しません。
- Mac通知の取り込みは試作段階です。一般アプリの通知転送・返信は未完成です。
- スリープ復帰、ネットワーク切断、長時間利用、全利用者環境での動作は引き続き検証中です。

## Development

```sh
npm ci
npm test
npm run test:http
npm run build
```

Macアプリのビルドとリリース手順は[開発ガイド](docs/development.md)に記載しています。ソースのコミットごとにアプリを置き換えず、テストしたバージョンをReleasesへ公開します。

## Privacy and license

[Data handling / データの扱い](docs/privacy.md) · [Third-party licenses](docs/dependencies.md)

Dot Linkの独自コードは[MIT License](LICENSE)です。依存ソフトはそれぞれのライセンスに従います。OpenAI、Even Realities、Tailscaleの公式製品ではありません。
