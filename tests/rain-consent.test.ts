import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RainConsent, SATELLITE_TERMS} from '../server/weather/rain-consent.ts';
import {WEATHER_TERMS} from '../src/weather-terms.ts';
import {WeatherSharing, type WeatherStatus} from '../src/weather-sharing.ts';

const owner = 'a'.repeat(64), other = 'b'.repeat(64);
const enabled = {version: 1, enabled: true, owner, terms: WEATHER_TERMS};
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'rain-consent-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const path = join(dir, 'weather.json'), sidecar = path + '.satellite-consent', staged = path + '.tmp';
  function stage(state: unknown) {writeFileSync(staged, JSON.stringify(state), {mode: 0o600, flag: 'wx'});}
  function save(state: unknown) {stage(state); renameSync(staged, path);}
  save(enabled);
  return {path, sidecar, staged, store: new RainConsent(path), stage, save};
}

test('combined grant pins its exact strict v1 generation and the selected intake time survives restart', t => {
  const f = fixture(t), originalBytes = readFileSync(f.path);
  assert.equal(f.store.since(owner), undefined, 'a preexisting MET grant permits no satellite acquisition');
  f.stage(enabled);
  assert.equal(f.store.grant(owner, 1234, f.staged), true);
  assert.equal(f.store.since(owner), undefined, 'a staged decision is not visible before primary commit');
  renameSync(f.staged, f.path);
  assert.deepEqual(readFileSync(f.path), originalBytes);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(statSync(f.sidecar).mode & 0o777, 0o700);
  assert.equal(new RainConsent(f.path).since(owner), 1234);
  assert.equal(f.store.since(other), undefined);
  assert.equal(f.store.grant(other, 42), false, 'a different paired subject cannot use this MET file');
  assert.equal(f.store.since(owner), 1234);
});

test('legacy same-value save, stop, re-enrollment and delete invalidate old NOAA consent', t => {
  const f = fixture(t);
  for (const action of ['same-value', 'off-on', 'other-owner', 'delete'] as const) {
    assert.equal(f.store.grant(owner, 20), true);
    if (action === 'off-on') f.save({version: 1, enabled: false, owner});
    if (action === 'other-owner') f.save({...enabled, owner: other});
    if (action === 'delete') unlinkSync(f.path);
    if (action !== 'same-value') assert.equal(f.store.since(owner), undefined);
    assert.equal(f.store.since(other), undefined);
    f.save(enabled);
    assert.equal(new RainConsent(f.path).since(owner), undefined, 'the old pin never authorizes an identical new JSON file');
  }
  assert.equal(f.store.grant(owner, 0), true);
  assert.equal(f.store.since(owner), 0);
  f.store.clear();
  assert.equal(f.store.since(owner), undefined);
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), enabled);
});

test('abandoned staged consent cannot be revived by a later same-owner v1 save', t => {
  const f = fixture(t); f.stage(enabled);
  assert.equal(f.store.grant(owner, 1000, f.staged), true);
  unlinkSync(f.staged); f.save(enabled);
  assert.equal(new RainConsent(f.path).since(owner), undefined);
  assert.equal(f.store.grant(owner, 2000), true);
  assert.equal(f.store.since(owner), 2000);
  assert.equal(readdirSync(f.sidecar).length, 1, 'only the active pin remains');
});

test('unavailable receipt or storage, mixed records and substituted files fail closed without changing MET', t => {
  const f = fixture(t), bytes = readFileSync(f.path);
  writeFileSync(f.sidecar, 'unavailable');
  assert.equal(f.store.grant(owner, 100), false);
  f.store.clear();
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(f.store.since(owner), undefined);
  unlinkSync(f.sidecar);
  assert.equal(f.store.grant(owner, 100), true);
  const [name] = readdirSync(f.sidecar);
  const pin = join(f.sidecar, name);
  unlinkSync(pin); writeFileSync(pin, bytes);
  assert.equal(f.store.since(owner), undefined);
  unlinkSync(pin); symlinkSync(f.path, pin);
  assert.equal(f.store.since(owner), undefined);
  unlinkSync(pin);
  assert.equal(f.store.grant(owner, 200), true);
  writeFileSync(join(f.sidecar, 'unexpected'), '');
  assert.equal(f.store.since(owner), undefined);
  assert.equal(f.store.grant(owner, 300), false);
  f.store.clear(); f.save(enabled); assert.deepEqual(readFileSync(f.path), bytes);
});

test('unrecognized grants, unsupported clocks and symlinked marker directories cannot enable NOAA', t => {
  const f = fixture(t);
  for (const state of [{...enabled, enabled: false}, {...enabled, version: 2}, {...enabled, terms: 'unknown'}, {...enabled, extra: 0}, {}]) {
    f.save(state); assert.equal(f.store.grant(owner, 42), false); assert.equal(f.store.since(owner), undefined);
  }
  f.save(enabled);
  for (const time of [-1, NaN, Infinity, 1.5]) assert.equal(f.store.grant(owner, time), false);
  const destination = f.path + '.elsewhere'; mkdirSync(destination); symlinkSync(destination, f.sidecar, 'dir');
  assert.equal(f.store.grant(owner, 42), false); assert.deepEqual(readdirSync(destination), []);
  assert.equal(f.store.since(owner), undefined);
});

const base = {weatherProtocol: 1, weatherEpoch: 'mac-epoch', weatherTerms: WEATHER_TERMS, weatherEnabled: true};
const capable = {...base, satelliteTerms: SATELLITE_TERMS, satelliteEnabled: false};
test('legacy companion/Mac requests stay byte-compatible and reconnect never broadens existing consent', async () => {
  const sent: unknown[] = []; let target = 'mac1', now = 100;
  const ui = new WeatherSharing({target: () => target, now: () => now, changed() {},
    api: async input => {sent.push(input); return base;}});
  ui.receive(base); await ui.control(true);
  assert.deepEqual(sent, [{protocol: 1, epoch: 'mac-epoch', enabled: true, terms: WEATHER_TERMS}]);
  await ui.control(true, true); assert.equal(ui.status().failed, true); assert.equal(sent.length, 1);
  for (const unsupported of [{...base, satelliteTerms: SATELLITE_TERMS}, {...capable, satelliteTerms: 'future'}]) {
    ui.receive(unsupported); assert.equal(ui.status().satelliteSupported, false);
  }
  ui.receive(capable); ui.receive(capable);
  assert.equal(ui.status().satelliteSupported, true); assert.equal(ui.status().satelliteEnabled, false);
  assert.equal(sent.length, 1);
  target = 'mac2'; assert.equal(ui.status().satelliteSupported, false);
  target = 'mac1'; now += 45_000; assert.equal(ui.status().satelliteSupported, false);
  await ui.control(true, true); assert.equal(sent.length, 1);
});

test('combined consent sends one selected disclosure, reports optional failure, and stop uses old protocol', async () => {
  const calls: unknown[] = []; let response: WeatherStatus = capable;
  const ui = new WeatherSharing({target: () => 'mac', changed() {}, api: async input => {calls.push(input); return response;}});
  ui.receive(capable); await ui.control(true, true);
  const combined = {protocol: 1, epoch: 'mac-epoch', enabled: true, terms: WEATHER_TERMS, satellite_terms: SATELLITE_TERMS};
  assert.deepEqual(calls, [combined]); assert.equal(ui.status().weatherEnabled, true); assert.equal(ui.status().satelliteFailed, true);
  ui.receive(capable); assert.equal(ui.status().satelliteFailed, true);
  response = {...capable, satelliteEnabled: true}; await ui.control(true, true);
  assert.equal(ui.status().satelliteFailed, false); assert.equal(ui.status().satelliteEnabled, true);
  response = {...capable, weatherEnabled: false}; await ui.control(false);
  assert.deepEqual(calls, [combined, combined, {protocol: 1, epoch: 'mac-epoch', enabled: false}]);
  assert.equal(ui.status().weatherEnabled, false); assert.equal(ui.status().satelliteEnabled, false);
});
