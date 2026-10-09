// Local-only fixture for official-simulator listing images. Never a real relay.
// Run after `npm run build`; open http://127.0.0.1:5197/?lang=ja (or en).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const languages = {
  ja: { text: '今日の午後、少し散歩しようかな。', reply: 'いいね。いつもの道を少し変えて、\n気になるカフェまで歩いてみよう。' },
  en: { text: 'I might go for a walk this afternoon.', reply: 'Take a different route today.\nMaybe stop at that cafe you wanted to try.' },
};
let language = 'ja';
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:5197');
    if (url.pathname === '/listing-proof') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="en"><title>Dot Link listing proof</title><style>body{background:#181c19;color:#eee;font:16px system-ui;margin:32px}figure{margin:24px 0}img{display:block;background:#000;width:576px;height:288px}figcaption{margin-top:8px;color:#bbb}</style><h1>Dot Link 0.2.14 — simulator capture</h1><p>Synthetic conversations. Official simulator 0.9.5; physical-device verification is separate.</p><figure><img src="/listing-conversation-ja.png"><figcaption>Japanese — original 576 × 288 transparent PNG on black.</figcaption></figure><figure><img src="/listing-conversation-en.png"><figcaption>English — original 576 × 288 transparent PNG on black.</figcaption></figure></html>');
      return;
    }
    if (/^\/listing-conversation-(ja|en)\.png$/.test(url.pathname)) {
      const lang = url.pathname.includes('-ja.') ? 'ja' : 'en';
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(await readFile(new URL(`../assets/store/screenshots/conversation-${lang}.png`, import.meta.url)));
      return;
    }
    if (url.pathname === '/api/updates') {
      // Bound polling so a static fixture cannot spin in a tight request loop.
      await new Promise(resolve => setTimeout(resolve, 500));
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ revision: `listing-${language}`, status: { subscribed: true, deviceName: 'My Mac' },
        messages: [{ id: `synthetic-listing-${language}`, ...languages[language], status: 'replied' }] }));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(404); response.end('Listing fixture: operation unavailable'); return;
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep) && path !== resolve(root, 'index.html')) {
      response.writeHead(403); response.end(); return;
    }
    let body = await readFile(path);
    if (path.endsWith('/index.html')) {
      language = url.searchParams.get('lang') === 'en' ? 'en' : 'ja';
      const fixture = `<script>
        localStorage.clear(); sessionStorage.clear();
        localStorage.setItem('dot-language', ${JSON.stringify(language)});
        localStorage.setItem('g2-device-token', 'D'.repeat(43));
        localStorage.setItem('dot-display-v1', JSON.stringify({idleSeconds:0,wakeTap:'double',headRaise:false,headAngle:20,neutralPitch:0}));
      </script>`;
      body = Buffer.from(body.toString().replace('<head>', '<head>' + fixture));
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404); response.end('Not found');
  }
});
server.listen(5197, '127.0.0.1', () => console.log('Synthetic listing preview: http://127.0.0.1:5197/?lang=ja'));
