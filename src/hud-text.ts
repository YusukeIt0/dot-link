import { getTextWidth } from '@evenrealities/pretext';

// Keep the 560px native scrolling container, but leave 30px between its
// text budget and right edge for the scrollbar and physical lens tolerance.
export const HUD_BODY_TEXT_WIDTH = 530;
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Display-only wrapping: retain the original message in history and on phone. */
export function wrapHudText(text: string): string {
  return text.split('\n').map(paragraph => {
    const lines: string[] = [];
    let line = '';
    for (const { segment } of words.segment(paragraph)) {
      if (getTextWidth(line + segment) <= HUD_BODY_TEXT_WIDTH) {
        line += segment;
        continue;
      }
      if (line) { lines.push(line); line = ''; }
      // Long words/URLs and unsupported clusters still remain complete.
      for (const { segment: glyph } of graphemes.segment(segment)) {
        if (line && getTextWidth(line + glyph) > HUD_BODY_TEXT_WIDTH) {
          lines.push(line); line = '';
        }
        line += glyph;
      }
    }
    lines.push(line);
    return lines.join('\n');
  }).join('\n');
}
