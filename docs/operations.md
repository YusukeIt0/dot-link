# Operations / 運用

Use the app's pause, resume, quit, and update controls for normal operation. Closing a window keeps the app resident. Quitting stops its relay services and prevents automatic relaunch until you open it again.

Dot Link owns its own launchd jobs. It must not change unrelated jobs or network settings. User data, keys, speech models, history, and pairing remain outside the app bundle in the installation data directory.

Updates replace the app and its bundled runtime. They retain the existing data directory and paused state. Before applying an update, the app waits for recent Even activity and pending requests, records a recovery journal, and backs up its app and service configuration. Backups are retained. Automatic rollback of an app that cannot launch at all is not implemented.

For source-based diagnostics, use `node scripts/setup.mjs status --voice-only` from the installation directory. Do not launch another relay on the same ports. Diagnostics and runtime files may contain private configuration; never attach the whole `.runtime` directory to a public issue.

日本語: 通常はアプリの一時停止・再開・終了・更新を使います。更新ではアプリ本体を置き換え、データ・ペアリング・停止状態を保持します。処理中の発話や直近のEven接続がある間は適用を待ちます。復旧情報とバックアップは残します。アプリ自体が起動不能になった場合の完全自動ロールバックは未実装です。公開Issueへ認証情報や`.runtime`全体を添付しないでください。
