# いつものDotとつなぐ / Connect your existing Dot

Dot Link uses your own Mac as a relay. Your existing ChatGPT Dot must have access to the required OpenAI plugin and secure tunnel features; the Mac download does not provision these features on your account.

1. OpenAIのトンネル設定で、自分のトンネルと認証情報を用意します。
2. Dot Linkの接続設定に、自分のトンネルIDと接続用の認証情報を入力します。キーをチャット・Git・スクリーンショットへ載せないでください。
3. 自分のChatGPT側で対応する接続を追加し、既存Dotから中継へアクセスできるようにします。
4. Dot Linkの接続状態を確認してから、MacでEven用コードを発行し、Even側へ貼り付けます。

トンネル認証、MacとiPhoneのTailscale接続、Evenのペアリングはそれぞれ目的が違います。アプリの更新には、これらとは別のGitHubキーを作る必要はありません。

Create your own OpenAI tunnel, enter its ID and credential in the Mac app, associate the connection with your existing ChatGPT Dot, then pair the Even companion using a code from the Mac. Keep credentials out of chat and source control. Do not copy another user's runtime folder or tunnel profile.

Availability of account features and clean setup on another user's account remain requirements to verify. The app does not create a replacement Dot or bypass account permissions.
