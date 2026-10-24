import { t, type TranslationKey } from './i18n.ts';
const messages: Record<string, TranslationKey> = {
  STT_BUSY: 'even.speech_recognition_is_busy_wait_a_moment_before_speaking_again',
  STT_KEY_REQUIRED: 'even.open_speech_input_on_your_mac_to_save_an_api',
  STT_CONFIG_REQUIRED: 'even.check_the_endpoint_in_speech_input_on_your_mac',
  STT_AUTH: 'even.the_api_key_was_rejected_check_speech_input_on_your',
  STT_QUOTA: 'even.check_your_speech_service_balance_or_limits_or_switch_to',
  STT_UNAVAILABLE: 'even.speech_recognition_is_unavailable_check_your_connection_and_speech_input',
  STT_TIMEOUT: 'even.speech_recognition_timed_out_try_again_or_switch_to_whisper',
  STT_CANCELLED: 'even.speech_recognition_was_cancelled',
  STT_INVALID_RESPONSE: 'even.the_speech_result_was_incomplete_please_speak_again',
  STT_NO_TEXT: 'even.no_words_were_recognized_please_speak_again',
};
export function sttErrorMessage(code: unknown): string | undefined {
  return typeof code === 'string' && Object.hasOwn(messages, code) ? t(messages[code]) : undefined;
}
