// Temporary, explicitly enabled local diagnostics. Never read field values or transmit data.
if (import.meta.env.VITE_VIEWPORT_DIAGNOSTICS === '1') {
  const main = document.querySelector<HTMLElement>('main')!;
  const panel = document.createElement('pre');
  panel.id = 'viewport-probe';
  panel.setAttribute('aria-hidden', 'true');
  Object.assign(panel.style, {position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
    margin: '0', padding: '5px 8px', minHeight: '0', maxWidth: '100%', pointerEvents: 'none',
    background: '#172334', color: '#ffffff', font: '10px/1.3 monospace', whiteSpace: 'pre',
    overflow: 'hidden', borderBottom: '1px solid #8bbcff'});
  document.body.append(panel);
  const started = performance.now();
  const labels: Record<string, string> = {'pair-code': 'CODE', 'mac-download-url': 'URL', transcript: 'MSG'};
  const focusRows: string[] = [];
  let latest = '';
  function sample(event: string, target?: EventTarget | null): string {
    const element = target instanceof HTMLElement ? target : document.activeElement;
    const focus = element instanceof HTMLElement ? labels[element.id] ?? '-' : '-';
    const viewport = window.visualViewport, rect = main.getBoundingClientRect();
    const numbers = [viewport?.height ?? window.innerHeight, viewport?.offsetTop ?? 0,
      rect.height, rect.top, main.scrollTop].map(Math.round);
    return `${((performance.now() - started) / 1000).toFixed(1).padStart(5)} ${event.padEnd(5)} ${focus.padEnd(4)} ${numbers.map(n => String(n).padStart(4)).join(' ')}`;
  }
  function render(): void {
    panel.textContent = `VIEWPORT DIAGNOSTICS  W=${Math.round(window.innerHeight)}\n    s event F       V    Y    H    T    S\n${focusRows.join('\n')}\n${latest}`;
  }
  function record(event: string, target?: EventTarget | null): void {
    focusRows.push(sample(event, target));
    if (focusRows.length > 5) focusRows.shift();
    render();
  }
  function refresh(): void { latest = sample('live'); render(); }
  for (const name of ['focusin', 'focusout'] as const) {
    main.addEventListener(name, event => {
      const target = event.target;
      record(name === 'focusin' ? 'in' : 'out', target);
      setTimeout(() => record('100ms', target), 100);
      setTimeout(() => record('500ms', target), 500);
    }, {passive: true});
  }
  window.visualViewport?.addEventListener('resize', refresh, {passive: true});
  window.visualViewport?.addEventListener('scroll', refresh, {passive: true});
  window.addEventListener('resize', refresh, {passive: true});
  main.addEventListener('scroll', refresh, {passive: true});
  // Let existing resize/focus handlers finish; this reads geometry without modifying it.
  setInterval(refresh, 250);
  record('start'); refresh();
}
