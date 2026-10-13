import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = stripTypeScriptTypes(await readFile(new URL('../src/keyboard-viewport.ts', import.meta.url), 'utf8')).replaceAll('export function', 'function');
test('keyboard focus, resize, dismissal and later manual scrolling preserve usable bounds', () => {
  class Field {
    getClientRects() { return [this.getBoundingClientRect()]; }
    getBoundingClientRect() { return {top: 1100 - scroller.scrollTop, bottom: 1200 - scroller.scrollTop}; }
  }
  const viewport = Object.assign(new EventTarget(), {height: 720, offsetTop: 0});
  const scroller = Object.assign(new EventTarget(), {style: {}, scrollTop: 600,
    contains: target => target === field,
    getBoundingClientRect: () => ({top: Number.parseFloat(scroller.style.top), bottom: Number.parseFloat(scroller.style.top) + Number.parseFloat(scroller.style.height)})});
  const field = new Field(), document = {activeElement: field};
  let frame, timer;
  const context = vm.createContext({window: Object.assign(new EventTarget(), {visualViewport: viewport}), document, scroller,
    HTMLTextAreaElement: Field, HTMLInputElement: class {},
    requestAnimationFrame: fn => { frame = fn; return 1; }, cancelAnimationFrame: () => { frame = undefined; },
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = undefined; }});
  vm.runInContext(source + '\nvar dispose = installKeyboardViewport(scroller);', context);
  const flush = () => { const fn = frame; frame = undefined; fn?.(); };
  const focus = name => { const event = new Event(name); Object.defineProperty(event, 'target', {value: field}); scroller.dispatchEvent(event); flush(); };
  flush(); focus('focusin');
  viewport.height = 330; viewport.dispatchEvent(new Event('resize')); flush();
  assert.equal(scroller.style.height, '330px');
  assert.ok(field.getBoundingClientRect().bottom <= 314);
  document.activeElement = null; focus('focusout');
  scroller.scrollTop -= 200;
  const immediateManualScroll = scroller.scrollTop;
  viewport.dispatchEvent(new Event('resize')); flush();
  assert.equal(scroller.scrollTop, immediateManualScroll, 'blurred field must not pull back an immediate flick-scroll');
  viewport.height = 720; viewport.dispatchEvent(new Event('resize')); flush(); timer?.(); flush();
  assert.equal(scroller.style.height, '720px');
  assert.equal(scroller.scrollTop, immediateManualScroll, 'settling timer must not reveal a blurred input');
  const restored = scroller.scrollTop;
  scroller.scrollTop += 80;
  viewport.dispatchEvent(new Event('scroll')); flush();
  assert.equal(scroller.scrollTop, restored + 80, 'viewport movement must not undo manual scrolling');
  vm.runInContext('dispose()', context);
  viewport.height = 300; viewport.dispatchEvent(new Event('resize'));
  assert.equal(frame, undefined, 'cleanup removes event listeners');
});
