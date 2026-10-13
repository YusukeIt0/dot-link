/** Keep the app's scroll area inside the visible part of an embedded WebView.
 * CSS viewport units alone need not shrink for the iOS software keyboard.
 */
export function revealDelta(fieldTop: number, fieldBottom: number, viewTop: number, viewBottom: number): number {
  const top = viewTop + 16, bottom = viewBottom - 16;
  if (fieldTop < top) return fieldTop - top;
  if (fieldBottom > bottom) return Math.min(fieldBottom - bottom, fieldTop - top);
  return 0;
}

export function installKeyboardViewport(scroller: HTMLElement): () => void {
  const viewport = window.visualViewport;
  let frame = 0;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let revealPending = false;
  function editable(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
    return (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)
      && !target.readOnly && !target.disabled;
  }
  function update(): void {
    frame = 0;
    const height = viewport?.height ?? window.innerHeight;
    // Direct iPhone URL refocus reported -380 after a 380px keyboard dismissal.
    // A negative native offset must not pull the app above its layout origin.
    const top = Math.max(0, viewport?.offsetTop ?? 0);
    scroller.style.height = `${height}px`;
    scroller.style.top = `${top}px`;
    if (!revealPending) return;
    revealPending = false;
    const field = editable(document.activeElement) ? document.activeElement : undefined;
    if (!field || !scroller.contains(field) || !field.getClientRects().length) return;
    const area = scroller.getBoundingClientRect(), rect = field.getBoundingClientRect();
    scroller.scrollTop += revealDelta(rect.top, rect.bottom, area.top, area.bottom);
  }
  function schedule(reveal = false): void {
    revealPending ||= reveal;
    if (!frame) frame = requestAnimationFrame(update);
  }
  function resized(): void { schedule(true); }
  function moved(): void { schedule(); }
  function focusChanged(event: FocusEvent): void {
    if (!editable(event.target)) return;
    const reveal = event.type === 'focusin';
    schedule(reveal);
    clearTimeout(settle);
    // Keyboard animation can finish after focusout without a further resize.
    settle = setTimeout(() => { schedule(reveal); }, 400);
  }
  viewport?.addEventListener('resize', resized);
  viewport?.addEventListener('scroll', moved);
  window.addEventListener('resize', resized);
  scroller.addEventListener('focusin', focusChanged);
  scroller.addEventListener('focusout', focusChanged);
  schedule();
  return () => {
    cancelAnimationFrame(frame); clearTimeout(settle);
    viewport?.removeEventListener('resize', resized);
    viewport?.removeEventListener('scroll', moved);
    window.removeEventListener('resize', resized);
    scroller.removeEventListener('focusin', focusChanged);
    scroller.removeEventListener('focusout', focusChanged);
  };
}
