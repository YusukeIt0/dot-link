import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
const source = stripTypeScriptTypes(await readFile(new URL('../src/viewport-diagnostics.ts', import.meta.url), 'utf8'));

test('disabled diagnostics install nothing in a normal build', () => {
  vm.runInNewContext(source.replace("import.meta.env.VITE_VIEWPORT_DIAGNOSTICS", "'0'"), {});
});
test('probe observes focus and geometry without reading values or moving the viewport', () => {
  class Element extends EventTarget {
    id = ''; style = {}; textContent = '';
    get value() { throw new Error('Must never read input contents'); }
    setAttribute() {}
  }
  const field = new Element(); field.id = 'pair-code';
  const main = Object.assign(new Element(), {scrollTop: 700, getBoundingClientRect: () => ({height: 330, top: 0})});
  main.style = new Proxy({}, {set: () => {throw new Error('Must not alter app layout');}});
  const panel = new Element(); const timers = []; let appended;
  const viewport = Object.assign(new EventTarget(), {height: 330, offsetTop: 0});
  const context = {HTMLElement: Element, document: {querySelector: () => main, createElement: () => panel,
    activeElement: field, body: {append: el => {appended = el;}}},
    window: Object.assign(new EventTarget(), {visualViewport: viewport, innerHeight: 720}), performance: {now: () => 1000},
    setTimeout: fn => timers.push(fn), setInterval: fn => timers.push(fn)};
  vm.runInNewContext(source.replace("import.meta.env.VITE_VIEWPORT_DIAGNOSTICS", "'1'"), context);
  const event = new Event('focusin'); Object.defineProperty(event, 'target', {value: field}); main.dispatchEvent(event);
  for (const fn of timers) fn();
  assert.equal(appended, panel); assert.equal(panel.style.pointerEvents, 'none');
  assert.match(panel.textContent, /CODE/); assert.match(panel.textContent, /330/); assert.match(panel.textContent, /W=720/);
  assert.equal(main.scrollTop, 700);
});
