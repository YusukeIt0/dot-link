# Dot Linkのデータの扱い / Data handling

更新日 / Updated: 2026-10-09。Mac 0.2.21と、Even側0.2.14候補の実装を対象にしています。Even Hubでの一般公開はまだです。This describes Mac 0.2.21 and the Even companion 0.2.14 candidate; the companion is not yet generally available in Even Hub.

## 日本語

Dot Linkは、Even G2と本人の既存ChatGPT Dotを、本人が管理するMacの中継で接続します。開発者が共用する会話サーバーは設けていません。MacとiPhoneには本人のTailscale接続が必要です。

### 取得・送信する内容

- **音声と会話:** 本人が録音を開始したときにG2の音声を取得します。長押しを離すか停止操作で終了し、最大30秒です。音声を自分のMacへHTTPSで送り、Mac上のWhisperで文字起こしします。Dot Linkは録音をOpenAIの音声認識サービスへ送りません。文字起こしした文章、または本人が入力して送信した文章は、個人用ChatGPT接続を通じて既存Dotへ渡します。Dotの返信・自発メッセージはMacからG2へ返します。
- **接続コードとカメラ:** 現在の接続方法は、Macで発行した接続コードをEven側へ貼り付ける方式です。この操作ではカメラを使いません。Even側0.2.14候補ではQRスキャン・写真読取処理とカメラ権限宣言を削除しました。0.2.13以前のEvenパッケージとMac 0.2.21同梱の旧画面には、非表示のQR処理・旧カメラ関連コードが残ります。接続コードは認証情報なので他人と共有しないでください。
- **頭の動き:** 「顔を上げると再表示」がオンのとき、G2の動きセンサーの値を取得し、端末内で表示を戻すか判断します。この設定は初期状態でオンで、表示設定からオフにできます。Dot Linkのコードには、このセンサー値をMacやDotへ送信したり、動きの履歴として保存したりする処理はありません。表示の基準角度などの設定値は保存します。
- **Macの通知:** 任意の試作機能です。監視が動作すると、macOSのアクセシビリティ機能を通じて通知センターのタイトル・説明・値の文字列を読み取り、メモリ上で判定します。読取対象には一般アプリの通知文字列も含まれ得ます。現在、自動転送するのはアプリが生成・識別した合成テスト通知に限定され、その内容はMacの中継からDotへ渡ります。一般通知の本文を転送する機能は未完成です。通知機能だけを停止しても、会話用の中継は別に動作します。
- **読み上げ:** 本人がオンにしたとき、Dotの返信を端末のWeb Speech APIへ渡します。音声処理が端末内で完結するかは、端末・音声エンジンに依存します。

### 保存するもの

**Mac:** 音声認識中は録音と認識結果を作業ディレクトリへ一時保存し、通常終了・処理エラー時に削除します。電源断やプロセス強制終了で残ったファイルの自動掃除は未実装です。会話履歴は最大100件、通知履歴は最大100件、自発メッセージは最大1,000件を保存します。自発メッセージの上限では新規受付を停止します。これらの履歴を日数で自動削除する仕組みはありません。Macの履歴とDot側の記憶・履歴は別です。

Macには、接続先・トンネル設定、OpenAIトンネル接続用の認証情報、中継用の認証キー、イベント配送先と配送用の秘密情報も保存します。これらはローカルファイルに保存し、秘密情報を含むファイルには所有者だけが読み書きできる権限を設定します。すべてをハッシュ化したり、Keychainに保存したりする方式ではありません。通知対象の選択、停止状態、言語、更新設定などはMacアプリの設定として保存します。

**Even側:** WebViewの保存領域とEven SDKのアプリ内保存機能を使い、接続先、端末用セッション、期限、接続元、更新後の再接続用認証情報を保存します。言語設定、表示を消すまでの時間、復帰操作、顔上げの有効・無効、角度・基準角度も保存します。Dot Link自身は、これらをOSのKeychainへ保存する処理を実装していません。

送信結果が不明な発話の重複防止には、IDと文章のSHA-256値を保存します。この記録に発話本文は保存しませんが、短い文章のハッシュは推測される可能性があり、匿名情報とは扱いません。

**接続の期限:** 接続コードは発行から2分・1回限り、端末セッションは最大90日です。再接続しても元の90日の期限は延長しません。Mac側のペアリング記録には、セッション・再接続用認証情報のハッシュ、接続元、期限を保存し、元のトークンは保存しません。この扱いはペアリング記録についての説明で、前述のトンネル用などの認証情報とは異なります。

### 診断と外部サービス

処理時間の診断ログには、処理ID・段階・時刻・所要時間を記録します。通知の診断には、許可・監視状態、選択したアプリ名、件数、合成テスト通知の本文と検知・転送結果などを保存します。一般通知の文字列は判定・重複防止のためメモリ上で扱いますが、現在の通知診断ファイルにはその本文を保存しません。これらの診断ファイルを開発者へ自動送信する処理はありません。問い合わせ時にファイルを共有する場合は、内容を確認してください。

Dot Link独自のアクセス解析・広告SDKは入れていません。初回の音声認識モデル取得はHugging Face、アプリ更新の配信情報・署名付きファイルの取得はGitHubへ接続します。配布先にはIPアドレスなど通常の接続情報が届きます。これらのダウンロード要求に会話・録音・ペアリング情報・トンネル認証情報を付加する処理はありません。更新用のGitHubキーは不要で、Sparkleのシステム情報送信は無効です。

OpenAIへ送る会話や、OS・Even・Tailscaleが扱う情報は、それぞれのサービスの規定・設定にも従います。この文書はDot Linkの実装を説明するもので、外部サービス内部の保存・削除を保証するものではありません。

### 接続解除と削除

- **Even側の「この端末の接続を解除」:** Macへセッション失効を要求し、Even側の接続情報を削除します。通信できない場合はMac側の失効が未完了と表示します。Macの会話履歴、Even側の言語・表示設定や重複防止用記録をすべて消す操作ではありません。Even SDKへの削除反映が失敗する可能性もあるため、接続権限を確実に止めるにはMac側の失効が必要です。
- **Mac側で全端末の接続を失効させる場合:** 保守用コマンド `node scripts/beta-pair.mjs revoke-all` を中継の作業ディレクトリで実行すると、接続コード・端末セッション・再接続用情報を失効させます。会話履歴やトンネル用認証情報の削除は別です。
- **Macアプリを取り除く場合:** アプリ内の「Dot Linkをアンインストール…」を使います。中継と通知を停止し、自動起動を解除して、アプリと専用の実行ファイル・音声認識モデルをゴミ箱へ移します。「接続設定と会話履歴も取り除く」は初期状態では未選択で、設定・履歴はMacに残ります。通常の導入先では保存用フォルダへ退避し、開発用配置では元の作業フォルダに残します。保管先は完了画面に表示します。
- **設定・履歴も取り除く場合:** 上記の項目を選ぶと、対象の設定・履歴もゴミ箱へ移します。即時の完全消去ではありません。開発用配置では既知の対象ファイルを取り除くため、独自に作ったファイル・過去のバックアップ・一部の旧ログなどは残ることがあります。端末のバックアップ、Even側の保存情報、以前の開発版がKeychainに保存した更新キー、外部サービスのデータまで一括削除する処理ではありません。

サービスの停止だけでは履歴は消えません。OpenAI等へ既に送信した内容は、各サービス側で別途管理・削除してください。

## English

Dot Link connects Even G2 to your existing ChatGPT Dot through a relay on a Mac you control. There is no shared conversation server operated by the developer. Your Mac and iPhone need your own Tailscale connection.

### What is collected and sent

- **Audio and conversations:** G2 audio is captured when you start recording, ending on release or a stop action, with a 30-second limit. Audio goes over HTTPS to your Mac for local Whisper transcription. Dot Link does not send recordings to OpenAI's transcription service. Transcribed or manually submitted text goes to your existing Dot through your personal ChatGPT connection. Replies and proactive messages return through the Mac to G2.
- **Pairing and camera:** The current pairing flow pastes a code generated on the Mac. It does not use the camera. The Even 0.2.14 candidate removes QR scanning, photo-reading code and the camera permission declaration. Earlier Even packages (0.2.13 and below) and the older web UI bundled with Mac 0.2.21 still contain hidden legacy QR/camera code. Pairing codes are credentials; do not share them.
- **Head movement:** With “Show when I raise my head” enabled, G2 motion sensor values are used locally to decide when to restore the display. This setting defaults to on and can be disabled in display settings. Dot Link has no code to send these sensor values to the Mac or Dot, or store a movement history. Settings such as the calibrated forward angle are saved.
- **Mac notifications:** This optional prototype reads Notification Center title, description and value strings through macOS Accessibility while monitoring is active. Ordinary application notification strings may be read into memory for classification. Current automatic forwarding is limited to synthetic test notifications generated and identified by the app; their content goes through the Mac relay to Dot. General notification-body forwarding is unfinished. Pausing notifications alone does not stop the conversation relay.
- **Read aloud:** When enabled, Dot replies are passed to the device's Web Speech API. Whether speech processing stays on the device depends on the device and voice engine.

### What is stored

**On the Mac:** Recordings and transcription output are temporary working files, removed on normal completion or processing errors. Automatic cleanup after power loss or forced termination is not implemented. Up to 100 conversations, 100 notifications and 1,000 proactive messages are stored. At the proactive-message limit, new submissions are refused. These histories are not automatically deleted by age. Mac history and Dot's own memory and history are separate.

The Mac also stores connection and tunnel settings, OpenAI tunnel credentials, relay authentication keys, and event delivery destinations and secrets. These are local files; files containing secrets are given owner-only read/write permissions. They are not all hashed or stored in Keychain. Notification selections, paused state, language and update preferences are stored as Mac app settings.

**On the Even side:** WebView storage and the Even SDK's app storage retain the relay address, session credential, expiry, app origin and update-recovery credential. Language and display preferences are also saved: idle time, wake gesture, head-raise enablement, angle and calibrated forward angle. Dot Link does not itself implement Keychain storage for these records.

An uncertain outgoing message has a saved ID and SHA-256 text digest for duplicate prevention. This record does not contain the message text. Short-text hashes may be guessable and are not treated as anonymous data.

**Pairing expiry:** Codes last two minutes and can be used once. Sessions last at most 90 days; recovery does not extend the original expiry. Mac pairing records retain hashes of session and recovery credentials, origins and expiry times, without the original tokens. This describes pairing records, not the separate tunnel and other credentials listed above.

### Diagnostics and external services

Timing logs contain processing IDs, stages, timestamps and durations. Notification diagnostics store permission and monitoring states, selected app names, counts, synthetic test notification bodies, and detection and forwarding results. Ordinary notification strings are handled in memory for classification and deduplication; their bodies are not stored in the current notification diagnostic file. These diagnostic files are not automatically sent to the developer. Review their contents before sharing them for support.

Dot Link has no app analytics or advertising SDK. Initial speech-model downloads connect to Hugging Face; update feeds and signed archives come from GitHub. Those hosts receive ordinary connection information such as IP addresses. Dot Link does not attach conversations, recordings, pairing credentials or tunnel credentials to those download requests. Updates require no GitHub token, and Sparkle system-profile reporting is disabled.

Conversations sent to OpenAI, and information handled by the OS, Even and Tailscale, are also subject to those services' rules and settings. This document describes Dot Link's implementation; it does not guarantee storage or deletion behavior inside external services.

### Disconnecting and deleting

- **“Revoke this device” on the Even side:** Requests session revocation on the Mac and removes local connection information. If communication fails, it reports that Mac-side revocation is incomplete. It does not erase Mac conversation history or all Even-side language, display and duplicate-prevention records. Deletion through the Even SDK can also fail; Mac-side revocation is needed to reliably invalidate access.
- **Revoking all devices on the Mac:** The maintenance command `node scripts/beta-pair.mjs revoke-all`, run in the relay working directory, invalidates pairing codes, sessions and recovery credentials. It does not delete conversation history or tunnel credentials.
- **Removing the Mac app:** Use “Uninstall Dot Link…” in the app. It stops the relay and notifications, removes login items, and moves the app, dedicated runtime and speech model to Trash. “Also remove connection settings and conversation history” defaults to unchecked. Settings and history then remain on the Mac: a standard installation moves them to a saved-data folder, while a development installation keeps them in its working folder. The completion dialog shows the retained-data location.
- **Also removing settings and history:** Selecting that option moves the targeted settings and history to Trash, rather than immediately and permanently erasing them. Development installations remove known target files; custom files, previous backups and some older logs may remain. This does not erase device backups, Even-side storage, update credentials stored in Keychain by earlier development releases, or data held by external services.

Stopping services alone does not delete history. Manage or delete information already sent to OpenAI or other services separately with those services.

## 問い合わせ / Contact

[GitHub Issues](https://github.com/YusukeIt0/dot-link/issues)で秘密情報を含まない不具合報告を受け付けます。認証情報、接続コード、録音、会話、未確認の診断ファイルを添付しないでください。

Use GitHub Issues for non-sensitive reports. Do not attach credentials, pairing codes, recordings, conversations or unreviewed diagnostic files.
