import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initAnalytics, pageContext, readConsent, consentKey, internalKey, consentLifetime, measurementId, ga4Contract } from '../site/analytics.mjs';
import { languages } from '../site/languages.mjs';

const contract = JSON.parse(readFileSync(new URL('./fixtures/ga4-contract.json', import.meta.url), 'utf8'));

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

test('a choice in another tab dismisses unanswered banners but preserves deliberately opened settings', () => {
  for (const choice of ['granted', 'denied']) {
    for (const settingsOpen of [false, true]) {
      const f = fixture();
      if (settingsOpen) f.nodes.settings.emit('click');
      f.values.set(consentKey, JSON.stringify({ choice, expires: Date.now() + 10000 }));
      f.win.emit('storage', { key: consentKey });
      assert.equal(f.nodes.consent.hidden, !settingsOpen);
      assert.equal(f.nodes.close.hidden, false);
      assert.equal(f.scripts.length, choice === 'granted' ? 1 : 0);
    }
  }
});

test('the GA4 reporting contract matches the static registry fixture and site markup', () => {
  // Plain JSON comparison in both directions: added, removed, renamed or reordered values fail.
  assert.deepEqual(JSON.parse(JSON.stringify(ga4Contract)), { events: contract.events, dimensions: contract.dimensions });
  assert.ok(Object.isFrozen(ga4Contract.dimensions.cta_id));
  const parameters = new Set(Object.values(contract.events).flat());
  assert.deepEqual([...parameters].sort(), Object.keys(contract.dimensions).filter(x => x !== 'site_lang').sort());
  const codes = languages.map(([code]) => code);
  assert.deepEqual(contract.dimensions.site_lang, codes);
  assert.deepEqual(contract.dimensions.target_lang, codes);
  const page = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  const used = [...page.matchAll(/data-analytics="([^"]*)" data-placement="([^"]*)"/g)].map(x => `${x[1]}:${x[2]}`);
  assert.equal(used.length, (page.match(/data-analytics=/g) ?? []).length, 'Every CTA must declare its placement next to its id');
  assert.deepEqual(used, ['install:hero', 'quickstart:hero', 'watch:hero', 'quickstart:setup', 'install:footer']);
  for (const pair of used) {
    const [id, placement] = pair.split(':');
    assert.ok(contract.dimensions.cta_id.includes(id) && contract.dimensions.placement.includes(placement), pair);
  }
});

test('each custom event carries only its contract parameters plus page context', () => {
  const f = fixture({ choice: 'granted' });
  f.click(); f.click('quickstart', 'setup'); f.click('watch'); f.click(null, null, 'fr');
  f.video.emit('playing'); f.video.emit('ended');
  const events = f.events();
  assert.deepEqual(events.map(x => x[1]), ['install_click', 'cta_click', 'cta_click', 'language_switch', 'video_start', 'video_complete']);
  for (const [, name, parameters] of events) {
    assert.deepEqual(Object.keys(parameters).sort(),
      [...contract.events[name], 'site_lang', 'page_location', 'page_referrer', 'send_to'].sort(), name);
    for (const key of contract.events[name]) assert.ok(contract.dimensions[key].includes(parameters[key]), `${name}.${key}`);
  }
  assert.deepEqual(events.map(x => x[2].cta_id ?? x[2].target_lang ?? x[2].video_id),
    ['install', 'quickstart', 'watch', 'fr', 'dot-link-introduction', 'dot-link-introduction']);
  assert.deepEqual(events.slice(0, 3).map(x => x[2].placement), ['hero', 'setup', 'hero']);
});

test('unknown identifiers, unknown languages and same-language links send nothing', () => {
  const f = fixture({ choice: 'granted' });
  f.click(null, null, 'es'); f.click(null, null, 'JA'); f.click(null, null, 'ja');
  f.click('Install', 'hero'); f.click('install', 'Hero'); f.click('watch', 'setup '); f.click('video', 'hero');
  for (const dataset of [{}, { analytics: 'install' }, { placement: 'hero' }]) {
    const link = { dataset, getAttribute: () => null, closest: () => null };
    f.doc.emit('click', { button: 0, target: { closest: () => link } });
  }
  assert.deepEqual(f.events(), []);
});

test('late consent starts the tag once and measures only later playback, once per page load', () => {
  const f = fixture();
  f.video.emit('playing');
  f.nodes.accept.emit('click');
  f.video.emit('ended');
  assert.deepEqual(f.events(), [], 'Playback observed before consent is neither replayed nor completed');
  f.video.emit('playing'); f.video.emit('ended');
  f.video.emit('playing'); f.video.emit('ended'); f.video.emit('playing'); f.video.emit('ended');
  assert.deepEqual(f.events().map(x => x[1]), ['video_start', 'video_complete']);
  assert.equal(f.scripts.length, 1);
});

test('one consented page load configures exactly one default page_view and never sends one manually', () => {
  const f = fixture({ choice: 'granted' });
  f.nodes.accept.emit('click');
  f.win.emit('pageshow'); f.doc.emit('visibilitychange');
  f.win.emit('storage', { key: consentKey }); f.win.emit('storage', { key: null });
  f.click(); f.video.emit('playing');
  const configs = f.win.dataLayer.filter(x => x[0] === 'config');
  assert.equal(configs.length, 1);
  assert.equal(configs[0][1], measurementId);
  assert.equal(configs[0][2].send_page_view, undefined, 'gtag default page_view stays enabled');
  assert.equal(f.events().filter(x => x[1] === 'page_view').length, 0);
  assert.equal(f.scripts.length, 1);
  assert.equal(f.reloads(), 0);
});

test('page and referrer URLs keep only known official paths or an origin', () => {
  const site = 'https://yusukeit0.github.io';
  const ja = `${site}/dot-link/ja/`;
  const referrerFor = referrer => pageContext(ja, referrer, 'ja').page_referrer;
  assert.equal(referrerFor(`${site}/dot-link/`), `${site}/dot-link/`);
  assert.equal(referrerFor(`${site}/dot-link/de/index.html?x=1#y`), `${site}/dot-link/de/`);
  assert.equal(referrerFor(`${site}/dot-link/es/`), `${site}/`);
  assert.equal(referrerFor(`${site}/other-project/private?q=1`), `${site}/`);
  assert.equal(referrerFor('http://example.test:8080/a/b?c=d#e'), 'http://example.test:8080/');
  for (const value of ['', 'not a url', 'android-app://com.example/path', 'javascript:alert(1)', 'file:///Users/me/page.html']) {
    assert.equal(referrerFor(value), '', value);
  }
  for (const href of [`${site}/dot-link/ja`, `${site}/dot-link/es/`, `${site}/dot-link/ja/other.html`,
    `${site}/dot-link/ja/ja/`, `${site}/dot-link//ja/`, `${site}/DOT-LINK/ja/`, 'https://www.yusukeit0.github.io/dot-link/ja/']) {
    assert.equal(pageContext(href, '', 'ja'), null, href);
  }
  assert.equal(pageContext(`${site}/dot-link/ja/index.html`, '', 'ja').page_location, ja);
});

test('campaign values are forwarded only as exact public slugs, never as raw query data', () => {
  const ja = 'https://yusukeit0.github.io/dot-link/ja/';
  const campaign = query => {
    const context = pageContext(`${ja}?${query}`, '', 'ja');
    assert.equal(context.page_location, ja);
    return Object.fromEntries(Object.entries(context).filter(([key]) => key.startsWith('campaign_')));
  };
  const long = 'a'.repeat(81);
  assert.deepEqual(campaign(`utm_source=Newsletter&utm_medium=e%20mail&utm_campaign=${long}&utm_content=-hero`), {});
  assert.deepEqual(campaign('utm_source=a%0Ab&utm_medium=%E0%A4%A&utm_campaign=x%2Fy&utm_content='), {});
  assert.deepEqual(campaign(`utm_source=first&utm_source=second&utm_campaign=${'a'.repeat(80)}&utm_term=keyword&gclid=secret`),
    { campaign_source: 'first', campaign_name: 'a'.repeat(80) });
  assert.deepEqual(campaign('%%%&&=&utm_medium=social_1'), { campaign_medium: 'social_1' });
});
