/** Defensive cleanup only; the detector already cuts audio at the wake phrase. */
export function wakeTranscript(text: string): string {
  const clean = text.trim().replace(/^(?:hey[\s,、，。・･.!！?？:：-]*dot\b|ヘイ[\s,、，。・･.!！?？:：-]*ドット)[\s,、，。・･.!！?？:：-]*/iu, '').trim();
  return /^(?:dot|ドット)[\s.!！?？。]*$/iu.test(clean) ? '' : clean;
}
