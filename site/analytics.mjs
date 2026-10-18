// Website-only analytics. This file is never included in the Mac or Even app.
export const measurementId = 'G-30KE8ZRSL9';
export const consentKey = 'dot-link.website.analytics-consent.v1';
export const internalKey = 'dot-link.website.analytics-internal.v1';
export const consentLifetime = 180 * 24 * 60 * 60 * 1000;
const origin = 'https://yusukeit0.github.io';
const languagePaths = new Map([
  ['/dot-link/', 'en'], ['/dot-link/ja/', 'ja'], ['/dot-link/zh-Hant/', 'zh-Hant'],
  ['/dot-link/zh-Hans/', 'zh-Hans'], ['/dot-link/ko/', 'ko'], ['/dot-link/ar/', 'ar'],
  ['/dot-link/fr/', 'fr'], ['/dot-link/de/', 'de'],
]);
const denied = { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };

export function readConsent(storage, now = Date.now()) {
  try {
    const value = JSON.parse(storage.getItem(consentKey));
    if (['granted', 'denied'].includes(value?.choice)
        && Number.isFinite(value.expires) && value.expires > now
        && value.expires <= now + consentLifetime) return value;
  } catch { /* Missing, inaccessible or invalid storage never grants consent. */ }
  return null;
}

export function pageContext(href, referrer, lang) {
  const url = new URL(href);
  const pathname = url.pathname.replace(/index\.html$/, '');
  if (url.origin !== origin || languagePaths.get(pathname) !== lang) return null;
  const context = { site_lang: lang, page_location: `${origin}${pathname}`, page_referrer: '' };
  try {
    const previous = new URL(referrer);
    if (['https:', 'http:'].includes(previous.protocol)) {
      const previousPath = previous.pathname.replace(/index\.html$/, '');
      context.page_referrer = previous.origin === origin && languagePaths.has(previousPath)
        ? `${origin}${previousPath}` : `${previous.origin}/`;
    }
  } catch { /* Direct visits have no referrer. */ }
  // Campaign names are public, lowercase slugs. Never forward arbitrary URL data.
  for (const [query, parameter] of [
    ['utm_source', 'campaign_source'], ['utm_medium', 'campaign_medium'],
    ['utm_campaign', 'campaign_name'], ['utm_content', 'campaign_content'],
  ]) {
    const value = url.searchParams.get(query);
    if (value && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value)) context[parameter] = value;
  }
  return context;
}

export function initAnalytics(win, doc) {
  const panel = doc.getElementById('analytics-consent');
  if (!panel) return;
  const settings = doc.getElementById('analytics-settings');
  const close = doc.getElementById('analytics-close');
  const internal = doc.getElementById('analytics-internal');
  const internalControls = doc.getElementById('analytics-internal-controls');
  const storageError = doc.getElementById('analytics-storage-error');
  const context = pageContext(win.location.href, doc.referrer, doc.documentElement.lang);
  const disableKey = `ga-disable-${measurementId}`;
  let storage;
  try { storage = win.localStorage; } catch { /* Fail closed. */ }
  let consent = readConsent(storage);
  let started = false;
  let stopped = false;
  let timer;
  let returnFocus = false;
  let videoStarted = false;
  let videoCompleted = false;
  const gtag = function () { win.dataLayer.push(arguments); };
  const readInternal = () => {
    try { return storage.getItem(internalKey) === 'true'; } catch { return false; }
  };
  let internalVisit = readInternal();
  internal.checked = internalVisit;
  win[disableKey] = true;

  function showSettings() {
    panel.hidden = false;
    close.hidden = !consent;
    internalControls.hidden = false;
    returnFocus = true;
    doc.getElementById('analytics-title').focus();
  }

  function hideSettings() {
    panel.hidden = true;
    if (returnFocus) settings.focus();
    returnFocus = false;
  }

  function clearCookies() {
    // Our cookie prefix/path isolate this site from other GitHub Pages projects.
    for (const part of doc.cookie.split(';')) {
      const name = part.trim().split('=')[0];
      if (/^dotlink_ga(?:_[A-Z0-9]+)?$/.test(name)) {
        doc.cookie = `${name}=; Max-Age=0; path=/dot-link/; SameSite=Lax; Secure`;
      }
    }
  }

  function stop() {
    win[disableKey] = true;
    stopped = started;
    if (started) {
      // Drop commands still waiting for a slow/blocked script. Never replay them.
      win.dataLayer.length = 0;
    }
    win.clearTimeout(timer);
    clearCookies();
  }

  function armExpiry() {
    win.clearTimeout(timer);
    if (!consent) return;
    timer = win.setTimeout(syncChoice, Math.min(consent.expires - Date.now() + 1, 2_147_483_647));
  }

  function start() {
    if (consent?.choice !== 'granted' || !context || !/^G-[A-Z0-9]+$/.test(measurementId)) return;
    if (stopped) {
      // A clean page avoids replaying the vendor's old consent/event state.
      win.location.reload();
      return;
    }
    if (started) return;
    started = true;
    win[disableKey] = false;
    win.dataLayer = [];
    win.gtag = gtag;
    gtag('consent', 'default', denied);
    gtag('consent', 'update', { ...denied, analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('config', measurementId, {
      ...context,
      ...(internalVisit ? { traffic_type: 'internal' } : {}),
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_prefix: 'dotlink', cookie_path: '/dot-link/', cookie_domain: 'none',
      cookie_expires: consentLifetime / 1000, cookie_update: false,
      cookie_flags: 'SameSite=Lax;Secure',
    });
    const script = doc.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
    doc.head.append(script);
    armExpiry();
  }

  function persist(key, value) {
    try {
      storage.setItem(key, value);
      if (storage.getItem(key) !== value) throw new Error('Storage write not retained');
      storageError.hidden = true;
      return true;
    } catch {
      consent = null;
      stop();
      panel.hidden = false;
      storageError.hidden = false;
      return false;
    }
  }

  function choose(choice) {
    const next = { choice, expires: Date.now() + consentLifetime };
    if (!persist(consentKey, JSON.stringify(next))) return;
    consent = next;
    if (choice === 'granted') start();
    else stop();
    hideSettings();
    armExpiry();
    if (choice === 'denied' && started) win.location.reload();
  }

  function syncChoice() {
    const next = readConsent(storage);
    const nextInternal = readInternal();
    const changed = next?.choice !== consent?.choice || nextInternal !== internalVisit;
    consent = next;
    internalVisit = nextInternal;
    internal.checked = internalVisit;
    if (changed && started) {
      stop();
      win.location.reload();
      return;
    }
    if (!consent) {
      stop();
      panel.hidden = false;
      close.hidden = true;
    } else if (consent.choice === 'granted') start();
    armExpiry();
  }

  function send(name, parameters) {
    if (!started || stopped || consent?.choice !== 'granted') return false;
    if (!readConsent(storage) || readConsent(storage)?.choice !== 'granted'
        || readInternal() !== internalVisit) {
      syncChoice();
      return false;
    }
    gtag('event', name, {
      ...parameters, ...context,
      ...(internalVisit ? { traffic_type: 'internal' } : {}),
      send_to: measurementId,
    });
    return true;
  }

  settings.hidden = false;
  settings.addEventListener('click', showSettings);
  close.addEventListener('click', hideSettings);
  doc.getElementById('analytics-accept').addEventListener('click', () => choose('granted'));
  doc.getElementById('analytics-reject').addEventListener('click', () => choose('denied'));
  internal.addEventListener('change', () => {
    const next = internal.checked;
    if (!persist(internalKey, String(next))) { internal.checked = internalVisit; return; }
    internalVisit = next;
    if (started) { stop(); win.location.reload(); }
  });
  win.addEventListener('storage', (event) => {
    if (event.key === null || [consentKey, internalKey].includes(event.key)) syncChoice();
  });
  win.addEventListener('pageshow', syncChoice);
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) syncChoice(); });

  function clicked(event) {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const link = event.target.closest?.('a');
    if (!link) return;
    const targetLang = link.getAttribute('hreflang');
    if (link.closest('.language-links') && [...languagePaths.values()].includes(targetLang)) {
      if (targetLang !== context?.site_lang) send('language_switch', { target_lang: targetLang });
      return;
    }
    const action = link.dataset.analytics;
    if (!['install', 'quickstart', 'watch'].includes(action)) return;
    const placement = link.dataset.placement;
    if (!['hero', 'setup', 'footer'].includes(placement)) return;
    send(action === 'install' ? 'install_click' : 'cta_click', { cta_id: action, placement });
  }
  doc.addEventListener('click', clicked);
  doc.addEventListener('auxclick', clicked);
  const video = doc.querySelector('#film video');
  video?.addEventListener('playing', () => {
    if (!videoStarted) videoStarted = send('video_start', { video_id: 'dot-link-introduction' });
  });
  video?.addEventListener('ended', () => {
    if (videoStarted && !videoCompleted) videoCompleted = send('video_complete', { video_id: 'dot-link-introduction' });
  });
  panel.hidden = Boolean(consent);
  start();
  armExpiry();
  if (win.location.hash === '#analytics-settings') showSettings();
  win.addEventListener('hashchange', () => {
    if (win.location.hash === '#analytics-settings') showSettings();
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') initAnalytics(window, document);
