import test from 'node:test';
import assert from 'node:assert/strict';
import { initAnalytics, pageContext, readConsent, consentKey, internalKey, consentLifetime, measurementId } from '../site/analytics.mjs';

const production = 'https://yusukeit0.github.io/dot-link/ja/';
class Target {
  listeners = new Map();
  hidden = true;
  addEventListener(name, fn) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  emit(name, values = {}) {
    for (const fn of this.listeners.get(name) ?? []) fn({ type: name, ...values });
  }
  focus() { this.focused = true; }
}
function fixture({ choice, href = production, internal = false, blocked = false } = {}) {
  const values = new Map();
  if (choice) values.set(consentKey, JSON.stringify({ choice, expires: Date.now() + consentLifetime - 100 }));
  if (internal) values.set(internalKey, 'true');
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (blocked) throw Error('blocked'); values.set(key, value); },
  };
  const ids = ['consent', 'settings', 'close', 'internal', 'internal-controls', 'storage-error', 'title', 'accept', 'reject'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Target()]));
  const scripts = [], cookies = [], timers = new Map();
  const video = new Target();
  const doc = Object.assign(new Target(), {
    referrer: 'https://example.com/private?secret=x', documentElement: { lang: 'ja' },
    getElementById: id => nodes[id.replace('analytics-', '')],
    querySelector: () => video,
    createElement: () => ({}), head: { append: script => scripts.push(script) },
  });
  Object.defineProperty(doc, 'cookie', { get: () => 'dotlink_ga=1; dotlink_ga_30KE8ZRSL9=2; other=3', set: value => cookies.push(value) });
  let reloads = 0;
  const win = Object.assign(new Target(), {
    localStorage: storage, location: { href, hash: new URL(href).hash, reload: () => reloads++ },
    setTimeout: fn => { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  initAnalytics(win, doc);
  const events = () => (win.dataLayer ?? []).map(x => [...x]).filter(x => x[0] === 'event');
  const click = (action = 'install', placement = 'hero', lang = null, type = 'click', button = 0) => {
    const link = { dataset: { analytics: action, placement }, getAttribute: () => lang, closest: () => lang ? {} : null };
    doc.emit(type, { button, target: { closest: () => link } });
  };
  return { win, doc, nodes, video, scripts, cookies, values, storage, timers, events, click, reloads: () => reloads };
}

test('only matching production language pages produce a sanitized context', () => {
  for (const lang of ['en', 'ja', 'zh-Hant', 'zh-Hans', 'ko', 'ar', 'fr', 'de']) {
    const path = `/dot-link/${lang === 'en' ? '' : `${lang}/`}`;
    const ctx = pageContext(`https://yusukeit0.github.io${path}index.html?secret=x&utm_source=newsletter&utm_medium=email&utm_campaign=launch-1&utm_content=hero&gclid=secret#private`, 'https://elsewhere.test/private?q=secret', lang);
    assert.deepEqual(ctx, { site_lang: lang, page_location: `https://yusukeit0.github.io${path}`, page_referrer: 'https://elsewhere.test/', campaign_source: 'newsletter', campaign_medium: 'email', campaign_name: 'launch-1', campaign_content: 'hero' });
  }
  assert.equal(pageContext('http://localhost/dot-link/ja/', '', 'ja'), null);
  assert.equal(pageContext(production, '', 'en'), null);
  assert.equal(pageContext('https://yusukeit0.github.io/other/', '', 'en'), null);
  assert.equal(pageContext(`${production}?utm_source=private%40mail.test`, '', 'ja').campaign_source, undefined);
  assert.equal(pageContext(production, `${production}?secret=x#private`, 'ja').page_referrer, production);
});

test('missing, invalid, expired, and inaccessible consent never grants tracking', () => {
  for (const value of [null, 'bad', '{}', '{"choice":"granted","expires":1}', JSON.stringify({ choice: 'granted', expires: Date.now() + consentLifetime * 2 })]) {
    assert.equal(readConsent({ getItem: () => value }), null);
  }
  assert.equal(readConsent({ getItem() { throw Error('blocked'); } }), null);
  for (const choice of [undefined, 'denied']) {
    const f = fixture({ choice });
    f.click(); f.video.emit('playing'); f.video.emit('ended');
    assert.equal(f.scripts.length, 0);
    assert.equal(f.win.dataLayer, undefined);
    assert.equal(f.win[`ga-disable-${measurementId}`], true);
  }
});

test('grant starts one tag with language, privacy and cookie options; prior actions are not replayed', () => {
  const f = fixture();
  f.click(); f.video.emit('playing');
  f.nodes.accept.emit('click');
  f.nodes.accept.emit('click');
  assert.equal(f.scripts.length, 1);
  assert.equal(f.scripts[0].src, `https://www.googletagmanager.com/gtag/js?id=${measurementId}`);
  const config = f.win.dataLayer.find(x => x[0] === 'config')[2];
  assert.equal(config.site_lang, 'ja');
  assert.equal(config.allow_google_signals, false);
  assert.equal(config.allow_ad_personalization_signals, false);
  assert.equal(config.cookie_update, false);
  assert.equal(config.cookie_path, '/dot-link/');
  assert.equal(f.events().length, 0);
  assert.equal(f.nodes.consent.hidden, true);
  const local = fixture({ choice: 'granted', href: 'http://localhost:4173/ja/' });
  assert.equal(local.scripts.length, 0);
});

test('custom events use bounded identifiers and source language, with one video start/end per page', () => {
  const f = fixture({ choice: 'granted' });
  f.click(); f.click('quickstart', 'setup'); f.click('watch');
  f.click(null, null, 'en'); f.click(null, null, 'ja');
  f.click('install', 'footer', null, 'auxclick', 1);
  f.click('install', 'footer', null, 'auxclick', 2);
  f.click('unknown'); f.click('install', 'private');
  f.video.emit('ended'); f.video.emit('playing'); f.video.emit('playing'); f.video.emit('ended'); f.video.emit('ended');
  assert.deepEqual(f.events().map(x => x[1]), ['install_click', 'cta_click', 'cta_click', 'language_switch', 'install_click', 'video_start', 'video_complete']);
  assert.equal(f.events()[3][2].target_lang, 'en');
  for (const event of f.events()) {
    assert.equal(event[2].site_lang, 'ja');
    assert.equal(event[2].send_to, measurementId);
  }
});

test('withdrawal drops pending events, disables tracking, clears only site cookies and reloads', () => {
  const f = fixture({ choice: 'granted' });
  f.click(); f.nodes.settings.emit('click'); f.nodes.reject.emit('click'); f.click();
  assert.equal(f.win[`ga-disable-${measurementId}`], true);
  assert.equal(f.win.dataLayer.length, 0);
  assert.equal(f.reloads(), 1);
  assert.equal(readConsent(f.storage).choice, 'denied');
  assert.equal(f.cookies.length, 2);
  assert.ok(f.cookies.every(x => x.startsWith('dotlink_ga') && x.includes('Max-Age=0')));
});

test('internal preference marks config and every custom event without using IP data', () => {
  const f = fixture({ choice: 'granted', internal: true });
  assert.equal(f.win.dataLayer.find(x => x[0] === 'config')[2].traffic_type, 'internal');
  f.click();
  assert.equal(f.events()[0][2].traffic_type, 'internal');
  f.nodes.internal.checked = false;
  f.nodes.internal.emit('change');
  assert.equal(f.storage.getItem(internalKey), 'false');
  assert.equal(f.reloads(), 1);
});

test('failed writes, cross-tab withdrawal, and expired consent stop collection', () => {
  const blocked = fixture({ blocked: true });
  blocked.nodes.accept.emit('click');
  assert.equal(blocked.scripts.length, 0);
  assert.equal(blocked.nodes['storage-error'].hidden, false);
  for (const mode of ['withdraw', 'expire', 'internal']) {
    const f = fixture({ choice: 'granted' });
    if (mode === 'withdraw') f.values.set(consentKey, JSON.stringify({ choice: 'denied', expires: Date.now() + 10000 }));
    if (mode === 'expire') f.values.set(consentKey, JSON.stringify({ choice: 'granted', expires: 1 }));
    if (mode === 'internal') f.values.set(internalKey, 'true');
    f.click();
    assert.equal(f.events().length, 0);
    assert.equal(f.win[`ga-disable-${measurementId}`], true);
    assert.equal(f.reloads(), 1);
  }
});
