import { validateWakeName } from './wake-name.ts';
/** Defensive cleanup only; the detector already cuts audio at the wake phrase.
 * Custom names use the literal ASCII spelling. Do not guess phonetic Japanese
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
  const clean = text.trim().replace(/^(?:hey[\s,、，。・･.!！?？:：-]*dot\b|ヘイ[\s,、，。・･.!！?？:：-]*ドット)[\s,、，。・･.!！?？:：-]*/iu, '').trim();
  return /^(?:dot|ドット)[\s.!！?？。]*$/iu.test(clean) ? '' : clean;
}
