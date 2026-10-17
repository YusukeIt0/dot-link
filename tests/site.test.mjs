import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.site/dot-link');
const base = 'https://yusukeit0.github.io/dot-link/';
const languages = ['en', 'ja', 'zh-Hant', 'zh-Hans', 'ko', 'ar', 'fr', 'de'];
const urlFor = (lang) => `${base}${lang === 'en' ? '' : `${lang}/`}`;

test('localized static pages are complete, mutually discoverable and use valid local links', () => {
  execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: root });
  const sitemap = readFileSync(resolve(output, 'sitemap.xml'), 'utf8');
  assert.equal((sitemap.match(/<loc>/g) ?? []).length, languages.length);
  for (const lang of languages) {
    const page = readFileSync(resolve(output, lang === 'en' ? '' : lang, 'index.html'), 'utf8');
    assert.ok(page.includes(`<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`));
    assert.ok(page.includes(`<link rel="canonical" href="${urlFor(lang)}">`));
    assert.ok(page.includes(`<meta property="og:url" content="${urlFor(lang)}">`));
    assert.ok(sitemap.includes(`<loc>${urlFor(lang)}</loc>`));
    assert.doesNotMatch(page, /\{\{|\}\}|<script\b|http-equiv="refresh"/i);
    assert.equal((page.match(/<h1\b/g) ?? []).length, 1);
    assert.equal((page.match(/aria-current="page"/g) ?? []).length, 1);
    for (const other of languages) {
      assert.ok(page.includes(`hreflang="${other}" href="${urlFor(other)}"`));
      assert.ok(page.includes(`lang="${other}" hreflang="${other}"`));
    }
    assert.ok(page.includes(`hreflang="x-default" href="${base}"`));
    for (const [, value] of page.matchAll(/(?:href|src|poster)="([^"]+)"/g)) {
      const url = new URL(value, urlFor(lang));
      if (!url.href.startsWith(base)) continue;
      const relative = url.pathname.slice(new URL(base).pathname.length);
      const target = resolve(output, relative, relative.endsWith('/') || !relative ? 'index.html' : '');
      assert.ok(existsSync(target), `${lang}: missing ${value}`);
      if (url.hash) {
        assert.ok(readFileSync(target, 'utf8').includes(`id="${url.hash.slice(1)}"`), `${lang}: broken ${value}`);
      }
    }
    for (const requirement of ['Apple Silicon', 'Tailscale', 'OpenAI', 'MCP', 'iPhone']) {
      assert.ok(page.includes(requirement), `${lang}: missing ${requirement}`);
    }
  }
});
