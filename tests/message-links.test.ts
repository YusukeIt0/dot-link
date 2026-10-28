import test from 'node:test';
import assert from 'node:assert/strict';
import { messageParts, withoutMessageUrls, withMessageUrlPlaceholders } from '../src/message-links.ts';

test('URL parsing preserves original text and identifies only explicit HTTP(S) and www addresses', () => {
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

test('HUD placeholders retain URL positions and Markdown labels without changing speech filtering', () => {
  const hint='[リンクはスマホで表示]';
  assert.equal(withMessageUrlPlaceholders('店舗情報：https://example.com。次です。',hint),`店舗情報：${hint}。次です。`);
  assert.equal(withMessageUrlPlaceholders('[Guide](https://example.com) https://example.org',hint),`Guide ${hint} ${hint}`);
  assert.equal(withMessageUrlPlaceholders('[https://example.com](https://example.com)',hint),hint);
  assert.equal(withMessageUrlPlaceholders('https://example.com',hint),hint);
  assert.equal(withoutMessageUrls('Guide https://example.com'),'Guide');
});
