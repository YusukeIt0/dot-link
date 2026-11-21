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

test('Trailing closer trimming stays linear for messages at the 8,000-character relay limit', () => {
  // Square brackets end a non-IPv6 match before trimming, so only () and {} can accumulate here.
  for (const [open, close] of [['(', ')'], ['{', '}']]) {
    const address = `https://example.com/${open}`;
    const text = address + close.repeat(8000 - address.length);
    assert.equal(text.length, 8000);
    const originalSplit = String.prototype.split;
    let splits = 0;
    String.prototype.split = function (this: string, ...args: Parameters<typeof originalSplit>) { splits++; return originalSplit.apply(this, args); } as typeof originalSplit;
    let link: string | undefined;
    try { link = messageParts(text).find(part => part.href)?.text; } finally { String.prototype.split = originalSplit; }
    assert.equal(link, `${address}${close}`);
    assert.equal(splits, 0, 'trimming must not re-split the remaining address for each removed closer');
  }
});

test('Balanced and unbalanced URL delimiters keep their established boundaries', () => {
  const links = (text: string) => messageParts(text).filter(part => part.href).map(part => part.text);
  assert.deepEqual(links('https://en.wikipedia.org/wiki/Example_(disambiguation)'), ['https://en.wikipedia.org/wiki/Example_(disambiguation)']);
  assert.deepEqual(links('(see https://example.com/a_(b)_{c})'), ['https://example.com/a_(b)_{c}']);
  assert.deepEqual(links('{https://example.com/path}}'), ['https://example.com/path']);
  assert.deepEqual(links('(https://example.com/a.)'), ['https://example.com/a.']);
  assert.equal(withoutMessageUrls('Map (https://example.com/a_(b)) here.'), 'Map () here.');
});
