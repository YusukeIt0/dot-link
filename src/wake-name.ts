export const MAX_WAKE_NAME_LENGTH = 24;
const reserved = new Set(['even', 'siri', 'meta']);
export type WakeNameError = 'letters' | 'reserved';
export type WakeNameResult = { name: string; error?: never } | { error: WakeNameError; name?: never };

export function validateWakeName(input: string): WakeNameResult {
  const name = input.trim();
  if (!/^[A-Za-z]{1,24}$/.test(name)) return { error: 'letters' };
  if (reserved.has(name.toLowerCase())) return { error: 'reserved' };
  return { name };
}

export interface WakeVocabulary { algorithm: string; pieces: [string, number][]; }

/** Exact maximum-score segmentation for the pinned SentencePiece unigram model.
 * Input is restricted to ASCII letters, so no Unicode normalization/unknown-token
 * fallback is needed. The historical model filename is bpe.model, but its
 * SentencePiece model type is UNIGRAM, not the greedy BPE merge algorithm.
 */
export function wakeNameTokens(name: string, vocabulary: WakeVocabulary): string[] {
  const checked = validateWakeName(name);
  if (checked.error || vocabulary.algorithm !== 'sentencepiece-unigram-ascii') throw new Error('Invalid wake name');
  const text = `▁HEY▁${checked.name.toUpperCase()}`;
  const scores = new Map(vocabulary.pieces);
  const best = Array<number>(text.length + 1).fill(-Infinity);
  const previous = Array<number>(text.length + 1).fill(-1);
  best[0] = 0;
  for (let start = 0; start < text.length; start++) {
    if (!Number.isFinite(best[start])) continue;
    for (let end = start + 1; end <= text.length; end++) {
      const score = scores.get(text.slice(start, end));
      if (score === undefined) continue;
      const candidate = Math.fround(best[start] + score);
      if (candidate > best[end]) { best[end] = candidate; previous[end] = start; }
    }
  }
  if (previous[text.length] < 0) throw new Error('Wake name cannot be tokenized');
  const tokens: string[] = [];
  for (let end = text.length; end > 0;) {
    const start = previous[end]; tokens.unshift(text.slice(start, end)); end = start;
  }
  return tokens;
}
