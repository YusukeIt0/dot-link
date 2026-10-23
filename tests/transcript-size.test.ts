import test from 'node:test';
import assert from 'node:assert/strict';
import { installTranscriptSize } from '../src/transcript-size.ts';

test('resizes drafts without collapsing the focused field and only reveals hidden growth', t => {
  let measured = 40, observed: () => void = () => {};
  const writes: string[] = [];
  const style = {height: '40px', overflowY: 'hidden'};
  const field = {
    value: '', scrollTop: 10, style: new Proxy(style, {set(target, key: keyof typeof style, value) {
      if (key === 'height') writes.push(value); target[key] = value; return true;
    }}),
    getClientRects: () => [1],
    getBoundingClientRect: () => ({width: 264, height: parseFloat(style.height), top: 300, bottom: 300 + parseFloat(style.height)}),
    addEventListener: () => {},
  };
  const measure = {style: {cssText: '', width: '', setProperty() {}}, value: '', setAttribute() {}, get scrollHeight() { return measured; }};
  const scroller = {scrollTop: 0, getBoundingClientRect: () => ({top: 0, bottom: 420})};
  const doc = {activeElement: field, body: {append() {}}, createElement: () => measure};
  const originals = new Map(['document', 'getComputedStyle', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  Object.assign(globalThis, {document: doc, getComputedStyle: () => ({lineHeight:'24px', paddingTop:'8px', paddingBottom:'8px', borderTopWidth:'0px', borderBottomWidth:'0px', getPropertyValue: () => ''}), ResizeObserver: class { constructor(callback: () => void) { observed = callback; } observe() {} }});
  const resize = installTranscriptSize(field as unknown as HTMLTextAreaElement, scroller as unknown as HTMLElement);
  assert.equal(style.height, '40px'); assert.equal(field.scrollTop, 0);
  field.value = 'two lines'; measured = 64; resize();
  assert.equal(style.height, '64px'); assert.equal(scroller.scrollTop, 0);
  field.value = 'long recognized speech'; measured = 184; resize();
  assert.equal(style.height, '136px'); assert.equal(style.overflowY, 'auto'); assert.equal(scroller.scrollTop, 32);
  assert.deepEqual(writes, ['40px', '64px', '136px'], 'focused field receives only final heights');
  const count = writes.length; observed(); assert.equal(writes.length, count, 'height notification does not cause a resize loop');
  field.value = 'short'; measured = 40; resize();
  assert.equal(style.height, '40px'); assert.equal(style.overflowY, 'hidden');
  field.value = ''; field.scrollTop = 50; resize();
  assert.equal(field.scrollTop, 0); assert.equal(style.height, '40px');
});
