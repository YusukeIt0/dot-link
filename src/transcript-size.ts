import { revealDelta } from './keyboard-viewport.ts';

/** Measure away from the focused field: temporarily collapsing it can move the
 * iOS caret and the containing scroll area before its final height is applied. */
export function installTranscriptSize(field: HTMLTextAreaElement, scroller: HTMLElement): () => void {
  const measure = document.createElement('textarea');
  measure.tabIndex = -1;
  measure.setAttribute('aria-hidden', 'true');
  measure.readOnly = true;
  document.body.append(measure);
  let width = 0;
  let frame = 0;
  const resize = () => {
    if (!field.getClientRects().length) return;
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    width = rect.width;
    measure.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;overflow:hidden;margin:0;';
    for (const property of ['box-sizing', 'font-family', 'font-size', 'font-weight', 'font-style',
      'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent',
      'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
      'border-top-width', 'border-bottom-width', 'border-left-width', 'border-right-width',
      'border-style', 'white-space', 'overflow-wrap', 'word-break', 'tab-size']) {
      measure.style.setProperty(property, style.getPropertyValue(property));
    }
    measure.style.width = `${width}px`;
    measure.value = field.value || ' ';
    const line = parseFloat(style.lineHeight);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const maximum = 5 * line + padding + border;
    const natural = measure.scrollHeight + border;
    measure.value = '';
    const height = Math.min(maximum, Math.max(line + padding + border, natural));
    field.style.height = `${height}px`;
    field.style.overflowY = natural > maximum ? 'auto' : 'hidden';
    if (!field.value) field.scrollTop = 0;
    if (height !== rect.height && document.activeElement === field) {
      const area = scroller.getBoundingClientRect();
      const updated = field.getBoundingClientRect();
      scroller.scrollTop += revealDelta(updated.top, updated.bottom, area.top, area.bottom);
    }
  };
  field.addEventListener('input', resize);
  // Covers orientation, layout width changes and becoming visible after pairing.
  // Defer writes out of observer delivery so changing height cannot generate
  // undelivered resize notifications in the same browser layout cycle.
  new ResizeObserver(() => {
    if (field.getBoundingClientRect().width !== width && !frame) {
      frame = requestAnimationFrame(() => { frame = 0; resize(); });
    }
  }).observe(field);
  resize();
  return resize;
}
