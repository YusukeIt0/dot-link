import test from 'node:test';
import assert from 'node:assert/strict';
import { messageParts, withoutMessageUrls, renderMessageLinks } from '../src/message-links.ts';

test('phone keeps original text and links only explicit HTTP(S) and www addresses', () => {
  const text = 'See https://example.com/a?q=one&b=two and www.example.org. <script>alert(1)</script> javascript:alert(1)';
  const parts = messageParts(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.href).map(part => part.href), ['https://example.com/a?q=one&b=two', 'https://www.example.org/']);
});
test('G2 and speech omit plain URLs while retaining multilingual prose and punctuation', () => {
  assert.equal(withoutMessageUrls('こちら https://example.com/path。次です。'), 'こちら 。次です。');
  assert.equal(withoutMessageUrls('Read https://example.com/a, then www.example.org!'), 'Read , then !');
  assert.equal(withoutMessageUrls('https://example.com'), '');
  assert.equal(withoutMessageUrls('hello\n\nworld'), 'hello\n\nworld');
});
test('Markdown labels survive multiple links, balanced parentheses and optional titles', () => {
  assert.equal(withoutMessageUrls('[First](https://example.com/a_(b)) and [Second](https://example.org "Source")'), 'First and Second');
  assert.equal(withoutMessageUrls('Source: <https://example.com/a>'), 'Source:');
  assert.equal(withoutMessageUrls('[https://example.com](https://example.com)'), '');
});
test('URL punctuation is excluded from destinations without breaking balanced path parentheses', () => {
  assert.deepEqual(messageParts('(https://example.com/a_(b)).').filter(p => p.href).map(p => p.text), ['https://example.com/a_(b)']);
  assert.equal(messageParts('https://example.com/path）次').find(p => p.href)?.text, 'https://example.com/path');
});
test('phone rendering uses text nodes and safe new-window links, never HTML injection', () => {
  const nodes: any[] = [];
  const container = { ownerDocument: {
    createTextNode: (text: string) => ({ text }),
    createElement: (tag: string) => ({ tag }),
  }, replaceChildren: (...items: any[]) => nodes.push(...items) };
  renderMessageLinks(container as unknown as HTMLElement, '<img onerror=alert(1)> https://example.com');
  assert.deepEqual(nodes, [{text:'<img onerror=alert(1)> '}, {tag:'a',textContent:'https://example.com',href:'https://example.com/',target:'_blank',rel:'noopener noreferrer'}]);
});
