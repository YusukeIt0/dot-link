import { getLanguage } from './i18n.ts';
const messages: Record<string, [string, string]> = {
  STT_BUSY: ['音声認識中です。少し待ってから話してください。', 'Speech recognition is busy. Wait a moment before speaking again.'],
  STT_KEY_REQUIRED: ['Macの音声入力設定でAPIキーを登録、またはアクセスを許可してください。', 'Open Speech input on your Mac to save an API key or allow access to it.'],
  STT_AUTH: ['APIキーを利用できません。Macの音声入力設定で確認してください。', 'The API key was rejected. Check Speech input on your Mac.'],
  STT_QUOTA: ['音声認識サービスの残高・利用枠を確認するか、MacでWhisperへ切り替えてください。', 'Check your speech service balance or limits, or switch to Whisper on your Mac.'],
  STT_UNAVAILABLE: ['音声認識サービスに接続できません。接続とMacの音声入力設定を確認してください。', 'Speech recognition is unavailable. Check your connection and Speech input on your Mac.'],
  STT_TIMEOUT: ['音声認識が時間内に終わりませんでした。再度話すか、MacでWhisperへ切り替えてください。', 'Speech recognition timed out. Try again or switch to Whisper on your Mac.'],
  STT_CANCELLED: ['音声認識を中止しました。', 'Speech recognition was cancelled.'],
  STT_INVALID_RESPONSE: ['音声認識の結果を受け取れませんでした。再度話してください。', 'The speech result was incomplete. Please speak again.'],
  STT_NO_TEXT: ['言葉を認識できませんでした。もう一度話してください。', 'No words were recognized. Please speak again.'],
};
export function sttErrorMessage(code: unknown): string | undefined {
  return typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code][getLanguage() === 'ja' ? 0 : 1] : undefined;
}
