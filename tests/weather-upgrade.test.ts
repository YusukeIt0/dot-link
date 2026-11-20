import test from 'node:test';
import assert from 'node:assert/strict';
import {WeatherSharing, type WeatherStatus} from '../src/weather-sharing.ts';
import {WEATHER_TERMS, SATELLITE_TERMS} from '../src/weather-terms.ts';

const met = {weatherProtocol: 1, weatherEpoch: 'epoch-1', weatherTerms: WEATHER_TERMS, weatherEnabled: true};
const eligible = {...met, satelliteTerms: SATELLITE_TERMS, satelliteEnabled: false};
const combined = {...eligible, weatherEpoch: 'epoch-2', satelliteEnabled: true};
type Offer = NonNullable<ReturnType<WeatherSharing['upgradeOffer']>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {resolve = ok; reject = fail;});
  return {promise, resolve, reject};
}

function fixture(saved = new Map<string, string>()) {
  const view = {origin: 'https://first.test', pairing: 'pairing-first', version: 1, foreground: true, now: 0};
  const requests: unknown[] = [];
  const seen = deferred<Offer>();
  const response = deferred<WeatherStatus>();
  const native = {getLocalStorage: async (key: string) => saved.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => {saved.set(key, value); return true;}};
  const sharing = new WeatherSharing({target: () => view.origin, now: () => view.now,
    upgrade: {pairing: () => view.pairing, sessionVersion: () => view.version, foreground: () => view.foreground},
    changed: () => {const offer = sharing.upgradeOffer(); if (offer) seen.resolve(offer);},
    api: async (body) => {requests.push(body); return response.promise;},
  });
  return {view, requests, response, sharing, native, saved, seen};
}

test('the foreground transition is available once only to a matching, current MET-only owner', {timeout: 3000}, async () => {
  const f = fixture();
  f.sharing.receive(eligible); assert.equal(f.sharing.upgradeOffer(), undefined);
  f.view.foreground = false; f.sharing.attachUpgradeStorage(f.native);
  for (const status of [eligible, met, combined, {...eligible, weatherEnabled: false}, {...eligible, satelliteTerms: 'different'}]) {
    f.sharing.receive(status); assert.equal(f.sharing.upgradeOffer(), undefined);
  }
  f.view.foreground = true;
  for (const status of [met, combined, {...eligible, weatherEnabled:false}, {...eligible, satelliteTerms:'different'}]) {
    f.sharing.receive(status); assert.equal(f.sharing.upgradeOffer(), undefined);
  }
  assert.equal(f.saved.size, 0); assert.equal(f.requests.length, 0);
  f.sharing.receive(eligible);
  const offer = await f.seen.promise;
  assert.equal(f.sharing.upgradeOffer(), offer);
  f.view.foreground = false; assert.equal(f.sharing.upgradeOffer(), undefined);
  await offer.accept(); assert.equal(f.requests.length, 0);
  f.view.foreground = true; f.sharing.receive(eligible); assert.equal(f.sharing.upgradeOffer(), offer);
  offer.dismiss(); await offer.accept(); f.sharing.receive(eligible);
  assert.equal(f.sharing.upgradeOffer(), undefined); assert.equal(f.requests.length, 0);
  assert.equal(f.saved.size, 2);
  const [[key, value]] = [...f.saved].filter(([key]) => key !== 'dot-weather-notice-ready');
  assert.match(key, /^dot-weather-[a-f0-9]{64}$/); assert.equal(value, 'shown');

  // New WebView, renewed session token/epoch, same pairing and native app store.
  const reopened = fixture(f.saved);
  const read = deferred<string>();
  reopened.sharing.attachUpgradeStorage({...reopened.native,
    getLocalStorage: async key => {read.resolve(key); return reopened.native.getLocalStorage(key);}});
  reopened.sharing.receive({...eligible, weatherEpoch:'after-restart'});
  assert.equal(await read.promise, key);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reopened.sharing.upgradeOffer(), undefined);
  assert.equal(reopened.requests.length, 0);
  reopened.view.pairing = 'another-owner-at-same-origin'; reopened.view.version++;
  reopened.sharing.receive(eligible);
  assert.ok(await reopened.seen.promise);
  assert.equal(f.saved.size, 3);
});

test('accept uses one request and a confirmed partial failure can be retried by the owner on that screen', {timeout: 3000}, async () => {
  const f = fixture();
  f.sharing.attachUpgradeStorage(f.native); f.sharing.receive(eligible);
  const offer = await f.seen.promise;
  const first = offer.accept(); await offer.accept();
  assert.deepEqual(f.requests, [{protocol:1, epoch:met.weatherEpoch, enabled:true, terms:WEATHER_TERMS, satellite_terms:SATELLITE_TERMS}]);
  f.response.resolve({...eligible, weatherEpoch:'after-partial'}); await first;
  assert.equal(f.sharing.status().satelliteFailed, true);
  assert.equal(f.sharing.status().satelliteEnabled, false);
  assert.equal(f.sharing.upgradeOffer(), offer);
  assert.equal(f.requests.length, 1);
  await offer.accept();
  assert.equal(f.requests.length, 2);
  assert.equal((f.requests[1] as {epoch:string}).epoch, 'after-partial');
  f.sharing.receive(combined);
  await offer.accept();
  assert.equal(f.requests.length, 2);
});

test('a lost response waits for current status before accepting an explicit retry; confirmed success ends the card', {timeout: 3000}, async () => {
  for (const result of [combined, eligible]) {
    const f = fixture();
    f.sharing.attachUpgradeStorage(f.native); f.sharing.receive(eligible);
    const offer = await f.seen.promise;
    const first = offer.accept(); f.response.reject(Error('unconfirmed')); await first;
    assert.equal(f.sharing.status().failed, true);
    assert.equal(f.sharing.upgradeOffer(), undefined);
    await offer.accept();
    await f.sharing.control(true, true); // The settings entry point also waits for fresh status.
    assert.equal(f.sharing.status().awaitingSatelliteStatus, true);
    f.sharing.receive(result);
    assert.equal(f.requests.length, 1);
    if (result.satelliteEnabled) assert.equal(f.sharing.upgradeOffer(), undefined);
    else assert.equal(f.sharing.upgradeOffer(), offer);
    await offer.accept();
    assert.equal(f.requests.length, result.satelliteEnabled ? 1 : 2);
  }
});

test('a stale card and a late control response cannot change another pairing, Mac, or grant', {timeout: 3000}, async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => {f.view.origin = 'https://other.test';},
    (f: ReturnType<typeof fixture>) => {f.view.pairing = 'new-owner';},
    (f: ReturnType<typeof fixture>) => {f.view.version++;},
    (f: ReturnType<typeof fixture>) => {f.sharing.receive({...met, weatherEpoch:'revoked', weatherEnabled:false});},
  ];
  for (const change of changes) {
    for (const before of [true,false]) {
      const f=fixture(); f.sharing.attachUpgradeStorage(f.native); f.sharing.receive(eligible);
      const offer=await f.seen.promise;
      if (before) change(f);
      const send=offer.accept();
      if (!before) change(f);
      f.response.resolve(combined); await send;
      assert.equal(f.requests.length, before ? 0 : 1);
      assert.notEqual(f.sharing.status().satelliteEnabled, true);
    }
  }
});

test('unconfirmed native storage or a stale snapshot never opens a card or grants access', {timeout: 3000}, async () => {
  for (const mode of ['unreadable','uncertain','write-failed','stale','owner-changed','unwritable']) {
    const f=fixture(); const read=deferred<string>();
    const started=deferred<void>(); const write=deferred<void>();
    f.sharing.attachUpgradeStorage({getLocalStorage: () => {started.resolve(); return read.promise;},
      setLocalStorage: async () => {write.resolve(); if(mode==='unwritable')throw Error('Unavailable'); return false;}});
    f.sharing.receive(eligible); await started.promise;
    if(mode==='stale') f.view.now = 45_000;
    if(mode==='owner-changed') f.view.pairing = 'different';
    if(mode==='unreadable') read.reject(Error('Unavailable'));
    else read.resolve(mode==='uncertain' ? 'unrecognized' : '');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.sharing.upgradeOffer(),undefined); assert.deepEqual(f.requests,[]);
    if(mode==='write-failed'||mode==='unwritable') await write.promise;
  }
});


test('backgrounding or closing during native preparation does not consume an unseen offer', {timeout: 3000}, async () => {
  const f = fixture();
  const started = deferred<void>(), finish = deferred<boolean>();
  f.sharing.attachUpgradeStorage({...f.native, setLocalStorage: async (key, value) => {
    if (key === 'dot-weather-notice-ready') {started.resolve(); await finish.promise;}
    return f.native.setLocalStorage(key, value);
  }});
  f.sharing.receive(eligible); await started.promise;
  f.view.foreground = false; finish.resolve(true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual([...f.saved], [['dot-weather-notice-ready', '1']]);
  assert.equal(f.sharing.upgradeOffer(), undefined);
  // Relaunch from a different WebView origin before the first actual presentation.
  const next = fixture(f.saved); next.sharing.attachUpgradeStorage(next.native); next.sharing.receive(eligible);
  const offer = await next.seen.promise;
  offer.dismiss(); assert.equal(next.sharing.upgradeOffer(), undefined);
  assert.equal([...f.saved.values()].includes('shown'), true);
  assert.equal(next.requests.length, 0);
});

test('native storage temporarily failing can recover on normal foreground status without repeating each poll', {timeout: 3000}, async () => {
  for (const fault of ['read', 'write']) {
    const f = fixture(); let ready = false, reads = 0;
    const tried = deferred<void>();
    f.sharing.attachUpgradeStorage({
      getLocalStorage: async key => {
        reads++;
        if (!ready && fault === 'read') {tried.resolve(); throw Error('offline');}
        return f.native.getLocalStorage(key);
      },
      setLocalStorage: async (key, value) => {
        if (!ready && fault === 'write') {tried.resolve(); return false;}
        return f.native.setLocalStorage(key, value);
      },
    });
    f.sharing.receive(eligible); await tried.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    f.view.now = 5000; ready = true;
    for (let i = 0; i < 4; i++) f.sharing.receive(eligible);
    assert.equal(reads, 1); assert.equal(f.sharing.upgradeOffer(), undefined);
    f.view.now = 30_000;
    f.sharing.receive(eligible);
    assert.ok(await f.seen.promise); assert.equal(reads, 2); assert.equal(f.requests.length, 0);
  }
});
