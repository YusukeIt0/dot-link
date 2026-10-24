import { validateWakeName } from './wake-name.ts';
import { defaultWakeTranscriptRules } from './wake-transcript-rules.ts';
/** Defensive cleanup only; the detector already cuts audio at the wake phrase.
 * Custom names use the literal ASCII spelling. Do not guess phonetic
 * aliases: removing a guessed word could erase the user's actual message.
 */
export function wakeTranscript(text: string, name = 'dot'): string {
  if (validateWakeName(name).error) return text.trim();
  if (name.toLowerCase() !== 'dot') {
    const separators = '[\\s,、，。・･.!！?？:：-]*';
    const cue = new RegExp(`^(?:hey|ヘイ)${separators}${name}(?=$|[^A-Za-z])${separators}`, 'iu');
    const clean = text.trim().replace(cue, '').trim();
    return new RegExp(`^${name}[\\s.!！?？。]*$`, 'iu').test(clean) ? '' : clean;
  }
  const trimmed = text.trim();
  const rule = defaultWakeTranscriptRules.find(rule => rule.prefix.test(trimmed));
  const clean = (rule ? trimmed.replace(rule.prefix, '') : trimmed).trim();
  return defaultWakeTranscriptRules.some(rule => rule.cueOnly?.test(clean)) ? '' : clean;
}
