import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { baseUrl, languages, pageUrl } from '../site/languages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.site/dot-link');
const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const template = await readFile(resolve(root, 'site/index.html'), 'utf8');
const english = JSON.parse(await readFile(resolve(root, 'site/locales/en.json'), 'utf8'));
const alternates = [...languages.map(([lang]) =>
  `  <link rel="alternate" hreflang="${lang}" href="${pageUrl(lang)}">`),
`  <link rel="alternate" hreflang="x-default" href="${baseUrl}">`].join('\n');

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'assets'), { recursive: true });

// Render complete static pages: no runtime translation or language redirects.
for (const [lang] of languages) {
  const copy = JSON.parse(await readFile(resolve(root, `site/locales/${lang}.json`), 'utf8'));
  if (Object.keys(copy).sort().join() !== Object.keys(english).sort().join()
      || Object.entries(copy).some(([key, value]) => typeof value !== 'string'
        || (!value.trim() && key !== 'heroEnd'))) {
    throw new Error(`Incomplete or unexpected translation fields: ${lang}`);
  }
  const values = {
    ...Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, escapeHtml(value)])),
    lang, direction: lang === 'ar' ? 'rtl' : 'ltr', canonical: pageUrl(lang),
    assetPrefix: lang === 'en' ? '' : '../', alternates,
    languageLinks: languages.map(([code, name]) =>
      `<a href="${code === 'en' ? (lang === 'en' ? './' : '../') : `${lang === 'en' ? '' : '../'}${code}/`}" lang="${code}" hreflang="${code}" dir="${code === 'ar' ? 'rtl' : 'ltr'}"${code === lang ? ' aria-current="page"' : ''}>${name}</a>`).join('\n      '),
  };
  const html = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown page field: ${key}`);
    return values[key];
  });
  if (html.includes('{{') || html.includes('}}')) throw new Error(`Unresolved page field: ${lang}`);
  const directory = lang === 'en' ? output : resolve(output, lang);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'index.html'), html);
}
await writeFile(resolve(output, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${languages.map(([lang]) => `  <url><loc>${pageUrl(lang)}</loc></url>`).join('\n')}\n</urlset>\n`);

// Copy only public styling and existing approved artwork, never the app build.
await copyFile(resolve(root, 'site/style.css'), resolve(output, 'style.css'));
await copyFile(resolve(root, 'site/analytics.mjs'), resolve(output, 'analytics.mjs'));
for (const [source, name] of [
  ['assets/brand/orbit/mark.svg', 'mark.svg'],
  ['assets/brand/orbit/mac-1024.png', 'mac-1024.png'],
  ['assets/readme/conversation-en.png', 'conversation-en.png'],
  ['assets/film/dot-link-introduction.mp4', 'dot-link-introduction.mp4'],
  ['assets/film/dot-link-introduction.jpg', 'dot-link-introduction.jpg'],
  ['assets/film/dot-link-introduction.en.vtt', 'dot-link-introduction.en.vtt'],
]) {
  await copyFile(resolve(root, source), resolve(output, 'assets', name));
}
console.log(`Static page ready: ${output}`);
