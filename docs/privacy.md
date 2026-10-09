# Dot Linkのデータの扱い / Data handling

Updated: 2026-10-09. This describes the open-source Mac release and Even companion. Even Hub general publication and cross-account setup validation remain incomplete.

## 日本語

Dot Linkは、Even G2と本人の既存ChatGPT Dotを、本人が管理するMacの中継で接続します。開発者が共用する会話サーバーは設けていません。MacとiPhoneには本人のTailscale接続が必要です。

### 取得・送信する内容

- **音声:** G2で録音を開始したときに取得します。長押しを離すか停止操作で終了し、最大30秒です。音声は選択したMacへHTTPSで送られ、MacのWhisperで文字起こしします。アプリは音声をOpenAIの音声認識サービスへ送りません。
- **会話:** 文字起こしした文章、または入力して送信した文章を、個人用ChatGPT接続を通じて既存Dotへ渡します。Dotの返信・自発メッセージをMacからG2へ返します。OpenAI側の取り扱いは本人のアカウントと同サービスの規定に従います。
- **QRの画像:** 本人が「QRをスキャン」を選ぶとライブカメラを要求し、映像を端末内だけで解析します。マイクは要求せず、画像の保存・送信・録画はしません。読み取り成功、閉じる、画面非表示、最長90秒で停止します。「QRを撮影」はEvenの静止画APIを使用する別の選択肢です。診断は処理段階、エラー名、WebViewの可否フラグのみで、端末画面に表示し外部送信しません。QRには短期の接続コードが含まれるため共有しないでください。通常手順は0.2.6の接続コード貼付です。QR経路は残存する任意の経路で、実機で読み取り成功を確認できていません。
- **Macの通知:** 任意の別機能です。現在の試作は合成テスト通知が対象で、一般アプリへの対応は未完成です。通知機能を停止しても会話用サービスは別に動作します。

### 保存するもの

録音は認識中にMacの非公開作業ディレクトリへ一時保存し、処理の正常終了・処理エラー時に削除します。電源断やプロセス強制終了時の残存ファイルの自動掃除は未実装です。残存の可能性を含め、Macの作業ディレクトリを他人と共有しないでください。

Macには会話履歴を最新100件、通知履歴を最新100件、自発メッセージを最大1000件保存します。自発メッセージの上限では新規受付を停止します。日数による自動削除はありません。履歴とDot側の記憶は別です。サービスの停止・自動起動解除だけでは履歴を削除しません。

Evenアプリ内の保存領域には、接続先、端末用セッション、期限、言語設定を保存します。送信結果が不明な発話の重複防止に、IDと文章のSHA-256値を保存します。発話本文はこの重複防止用の記録には保存しませんが、短い文章のハッシュは内容を推測される可能性があるため匿名情報とは扱いません。

ペアリング招待は2分間・一回限り、端末セッションは最大90日間です。Mac側のセッション記録はトークンのハッシュとオリジン・期限で、トークンそのものは記録しません。端末側の保存領域はOSのKeychainではありません。端末・Macのログイン保護が必要です。

診断は接続状態、時刻、処理時間、エラー種別を扱います。アプリ独自のアクセス解析・広告SDKは入れていません。アプリの診断に音声・会話・通知本文や鍵を意図的に記録しません。OS、Even、OpenAI、Tailscaleが扱う情報はそれぞれのサービスの範囲です。任意の読み上げはWeb Speech APIを利用し、実際の音声処理場所は端末・音声エンジンに依存します。

### 接続解除と削除

端末の「接続解除」はMacへセッション失効を要求してから端末設定を削除します。通信できない場合、Mac側の失効は未完了と表示します。その場合はMacで `node scripts/beta-pair.mjs revoke-all` を実行し、ベータの招待と端末セッションを失効させます。従来の開発用キーは別管理です。

全体を削除する場合は、先にサービスの停止・自動起動解除を行い、必要なデータの保管を本人が判断してからプロジェクトの`.runtime/`を削除します。OpenAI等に既に送信した内容の削除は各サービスで行います。

## English

Dot Link connects Even G2 to your existing ChatGPT Dot through a relay on a Mac you control. There is no shared conversation server operated by the developer. Your iPhone and Mac need your own Tailscale connection.

**Audio and messages.** Recording starts when you request it, stops on release or a stop action, and lasts at most 30 seconds. Audio goes over HTTPS to your selected Mac for local Whisper transcription. The app does not send audio to OpenAI's transcription service. Transcribed or typed messages are sent to your existing Dot through your personal ChatGPT connection. Replies and proactive messages return through the Mac. OpenAI's handling is governed by your account and its service policies.

**Pairing camera.** “Scan QR” requests live camera frames for on-device decoding only, without audio, recording, image storage or upload. Capture stops on success, close, hidden page or after 90 seconds. “Take a QR photo” uses Even’s still-image API as a separate option. Diagnostics show only the operation stage, error name and WebView capability flags locally; they are not transmitted. Pairing codes are secrets and should not be shared. The normal flow in 0.2.6 pastes a complete pairing code. QR capture remains an optional legacy path without successful hardware verification. Optional Mac notification capture is integrated into the Mac client; forwarding from general applications is not yet supported.

**Storage.** Audio is temporarily written to a private Mac working directory and removed when processing completes or returns an error. Cleanup after a power loss or forced process termination is not implemented. The Mac stores the latest 100 voice conversations, 100 notifications, and up to 1,000 proactive messages. New proactive messages are refused at that limit. There is no age-based deletion. Stopping or uninstalling login services preserves this history. This relay history is separate from Dot's memory.

The Even app's local storage retains the relay address, session credential, expiry, and language. An uncertain outgoing message is represented by an ID and a SHA-256 digest for duplicate prevention, without its text in that record. A digest of a short message may be guessable; it is not treated as anonymous data. Invitations expire in two minutes and can be used once; sessions last up to 90 days. The Mac stores session token hashes, origins and expiry times. The phone's local storage is not an OS keychain. Protect both devices with your normal device security.

**Diagnostics and other services.** App diagnostics use connection states, timestamps, durations, and error types. There are no app analytics or advertising SDKs. The app does not intentionally log audio, conversation or notification bodies, or keys. The OS, Even, OpenAI and Tailscale have their own data handling. Optional spoken replies use the Web Speech API; the actual processing location depends on the device and speech engine.

**Disconnect and deletion.** Disconnect requests session revocation on the Mac and removes local connection settings. If the Mac cannot be reached, the app reports that revocation is incomplete. Run `node scripts/beta-pair.mjs revoke-all` on the Mac to revoke all beta invitations and sessions. Legacy development keys are managed separately. To remove local data, first stop and unregister the services, decide what to keep, then remove the project's `.runtime/` directory. Content already sent to external services must be managed through those services.

Questions and non-sensitive bug reports: https://github.com/YusukeIt0/dot-link/issues. Do not attach private runtime files, credentials, or conversations. Installed-device and cross-account validation remain ongoing.


## App updates / アプリの更新

The app checks a public GitHub-hosted feed and downloads signed release archives. GitHub receives ordinary connection information such as the requesting IP address. No GitHub token, conversation, pairing code, or tunnel credential is sent for an update. Sparkle system-profile reporting is disabled.

更新はGitHub上の公開配信情報と署名付きアプリを取得します。更新用キーは不要で、会話・ペアリング・トンネル認証情報を更新先へ送りません。GitHubには通常の通信情報が届きます。Sparkleのシステム情報送信は無効です。
