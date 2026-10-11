# いつものDotとつなぐ / Connect your existing Dot

Dot Link uses your own Mac as a relay. Your existing ChatGPT Dot must have access to the required OpenAI plugin and secure tunnel features; the Mac download does not provision these features on your account.

1. OpenAIのトンネル設定で、自分のトンネルと認証情報を用意します。
2. Dot Linkの接続設定に、自分のトンネルIDと接続用の認証情報を入力します。キーをチャット・Git・スクリーンショットへ載せないでください。
3. 自分のChatGPT側で対応する接続を追加し、既存Dotから中継へアクセスできるようにします。
4. Dot Linkの接続状態を確認してから、MacでEven用コードを発行し、Even側へ貼り付けます。

トンネル認証、MacとiPhoneのTailscale接続、Evenのペアリングはそれぞれ目的が違います。アプリの更新には、これらとは別のGitHubキーを作る必要はありません。

Create your own OpenAI tunnel, enter its ID and credential in the Mac app, associate the connection with your existing ChatGPT Dot, then pair the Even companion using a code from the Mac. Keep credentials out of chat and source control. Do not copy another user's runtime folder or tunnel profile.

Availability of account features and clean setup on another user's account remain requirements to verify. The app does not create a replacement Dot or bypass account permissions.

## 音声入力 / Speech input

初期値は無料のWhisper smallです。Macの「音声入力」からSoniox stt-rt-v5、ElevenLabs scribe_v2、Microsoft MAI-Transcribe-2、OpenAI gpt-transcribe、AssemblyAI universal-3-5-proを選べます。外部サービスでは本人のAPIキーをMacアプリの入力欄へ直接保存してください。キーはサービス別にキーチェーンへ保存し、選択先だけを使用します。Microsoftのみ、Azureで作成したSpeechリソースの接続先も必要です。画面下部の「接続先について」から取得方法を参照できます。

Free Whisper small is the default. Speech input on the Mac also offers Soniox stt-rt-v5, ElevenLabs scribe_v2, Microsoft MAI-Transcribe-2, OpenAI gpt-transcribe and AssemblyAI universal-3-5-pro. Enter your own service key directly in the Mac app; each key is stored separately in Keychain, and only the selected service is used. Microsoft additionally requires your Azure Speech resource endpoint. Use About the endpoint below the settings card for instructions.

Mac・iPhone・G2は選択したサービスとモデルを表示します。外部サービスへの接続は実際の音声入力時に確認し、保存だけでAPI接続成功とは扱いません。利用権限・課金・対応リージョン等は本人の各社アカウントに従います。

Mac, iPhone and G2 show the selected service and model. API access is checked when you use speech input; saving a key does not verify access. Your service account determines permissions, billing and supported regions.
