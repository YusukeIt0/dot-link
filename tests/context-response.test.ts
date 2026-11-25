import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {Bridge} from '../server/bridge.ts';
import {LocationContext} from '../server/location.ts';
import {LocationHistoryStore} from '../server/history/store.ts';
import {HealthContext} from '../server/health/context.ts';
import {HealthVault} from '../server/health/vault.ts';
import {normalize} from '../server/health/data.ts';
import {WeatherContext, WEATHER_TERMS} from '../server/weather/context.ts';
import {weatherSource, type WeatherEvidence} from '../server/weather/types.ts';
import {MobilityAcquisition} from '../server/mobility/context.ts';
import {WebhookSender} from '../server/webhook.ts';
import {rpc} from '../server/http.ts';
import {ContextResponder} from '../server/context-response.ts';

const owner = 'a'.repeat(64), NOW = Date.parse('2026-11-14T12:00:00Z');
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'combined-context-'));
  let now = NOW, authorized = true, block: Promise<void> | undefined, unblock = () => {}, sequence = 0;
  const sender = new WebhookSender(async (_url, raw) => {
    const p = JSON.parse(raw);
    if (p.type === 'verification') return {status: 200, body: JSON.stringify({challenge: p.challenge})};
    await block; return {status: 202, body: '{}'};
  });
  const bridge = new Bridge(join(dir, 'bridge.json'), sender, ['callback.example.test']);
  const acquisition = new MobilityAcquisition(() => ({walking: {plan: async () => {throw Error('not requested');}},
    terrain: {clear() {}, elevations: async points => points.map(() => 12), profile: async () => {throw Error('not requested');}}}), () => now);
  const location = new LocationContext(join(dir, 'location.json'), sender, [], bridge.sendMessage.bind(bridge), () => now,
    () => authorized, undefined, () => acquisition);
  const history = new LocationHistoryStore(join(dir, 'history'), {now: () => now, ownerAuthorized: () => authorized,
    ownerRevoked: () => !authorized, announce: bridge.sendMessage.bind(bridge)});
  const key = randomBytes(32), path = join(dir, 'health.enc');
  new HealthVault(path).write(key, {version: 1, enabled: true, owner, deletedBefore: 0, profileDeleted: false,
    connection: {clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture', userId: 1, expiresAt: NOW + 86400_000},
    observations: normalize('heart_rate', [{date: '2026-11-14', heart_rate_samples: [{sample_time: '09:00:00', heart_rate: 60}]}], now)});
  const health = new HealthContext(path, {key: async () => Buffer.from(key), now: () => now,
    ownerAuthorized: () => authorized, ownerRevoked: () => !authorized, sender, hosts: [],
    phoneTime: (dates, id) => history.readPhoneTime(dates, id), announce: bridge.sendMessage.bind(bridge)});
  await health.setup({action: 'status'});
  const weather = new WeatherContext(join(dir, 'weather.json'), {cancel() {}, close() {}, query: async point => ({
    status: 'ready', source: weatherSource, data_kind: 'model_forecast', query_point: point,
    as_of: new Date(now).toISOString(), retrieved_at: new Date(now).toISOString(), checked_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(), retry_at: null, elevation_m: 12, apparent_temperature_c: null,
    limitations: [], forecast: [], current: null,
  } as WeatherEvidence)}, location, {now: () => now, automatic: false, ownerAuthorized: () => authorized});
  let sharing = randomUUID();
  const start = () => location.control({sharing_id: sharing, enabled: true, mobility_enabled: true}, owner);
  const update = (latitude = 10) => location.update({sharing_id: sharing, sequence: ++sequence,
    fix: {latitude, longitude: 20, accuracy: 5, measured_at: new Date(now).toISOString()}}, owner);
  const stop = () => location.control({sharing_id: sharing, enabled: false}, owner);
  const historyControl = (action: string) => history.control({protocol: 1, epoch: history.status(owner).historyEpoch, action}, owner);
  const healthControl = (action: string) => health.control({protocol: 1, epoch: health.status(owner).healthEpoch, action}, owner);
  const weatherControl = (enabled: boolean) => weather.control({protocol: 1, epoch: weather.status(owner).weatherEpoch, enabled, ...(enabled ? {terms: WEATHER_TERMS} : {})}, owner);
  start(); update(); historyControl('enable'); now++;
  history.ingest({latitude: 10, longitude: 20, accuracy: 5, measured_at: new Date(now).toISOString()}, sharing,
    {protocol: 1, epoch: history.status(owner).historyEpoch, timezone: 'Etc/UTC', utc_offset_minutes: 0}, owner);
  weatherControl(true);
  await bridge.subscribe({name: 'utterance.created', arguments: {session_id: 'personal-g2'},
    delivery: {mode: 'webhook', url: 'https://callback.example.test/events', secret: 'whsec_' + randomBytes(32).toString('base64')}});
  const question = randomUUID(); await bridge.submit({id: question, text: 'Public fixture question'});
  t.after(() => {unblock(); health.close(); weather.close(); location.close(); history.close(); bridge.close(); rmSync(dir, {recursive: true, force: true});});
  const call = (name: string, args: unknown) => rpc(bridge, {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}},
    undefined, location, history, weather, undefined, health) as Promise<any>;
  const receipts = () => ({context_id: location.read().context!.context_id,
    health_read_ids: [(health.read({categories: ['heart_rate']}) as any).read_id],
    history_context_ids: [(history.read() as any).history_context_id]});
  return {bridge, location, history, health, weather, question, call, receipts, healthControl, historyControl, weatherControl, stop, update,
    advance(ms: number) {now += ms;}, revoke() {authorized = false;},
    async holdBridge() {block = new Promise<void>(resolve => {unblock = resolve;}); const pending = bridge.submit({id: randomUUID(), text: 'Queue barrier'}); await settle(); return {pending, release() {unblock(); block = undefined;}};},
    restartLocation() {stop(); sharing = randomUUID(); start(); update();},
  };
}

test('real RPC composes health, place history, location, weather and mobility into one linked commit and retry', async t => {
  const f = await fixture(t);
  const weather = (await f.call('get_weather_context', {mode: 'current'})).result.structuredContent;
  const mobility = (await f.call('get_mobility_context', {context_id: weather.context_id, walking: false, terrain: true})).result.structuredContent;
  const p = {...f.receipts(), weather_read_ids: [weather.weather_read_id], mobility_read_ids: [mobility.mobility_read_id],
    disposition: 'announce', utterance_id: f.question, text: 'One useful combined answer with Polar context.'};
  const [a, b] = await Promise.all([f.call('respond_to_context', p), f.call('respond_to_context', p)]);
  assert.deepEqual(a, b); assert.equal(a.result.structuredContent.stored_for_g2, true);
  assert.equal(a.result.structuredContent.physical_display_confirmed, false);
  assert.equal(f.bridge.history().find(x => x.id === f.question)!.reply, p.text);
  assert.equal(f.bridge.outboundHistory().length, 0, 'initial answer is not a separate proactive page');
  assert.equal(f.location.status().locationAnnouncementCount, 1);
  assert.equal(f.location.read().recent_announcements.at(-1), p.text);
  assert.equal((await f.call('respond_to_context', {...p, text: 'Conflicting answer'})).error.data.reason, 'context_decision_conflict');
});

for (const [kind, change, expected] of [
  ['health OFF', (f: Awaited<ReturnType<typeof fixture>>) => f.healthControl('disable'), 'health_access_changed'],
  ['health deletion', (f: Awaited<ReturnType<typeof fixture>>) => f.healthControl('delete'), 'health_access_changed'],
  ['history OFF', (f: Awaited<ReturnType<typeof fixture>>) => f.historyControl('disable'), 'history_access_changed'],
  ['history deletion', (f: Awaited<ReturnType<typeof fixture>>) => f.historyControl('delete'), 'history_access_changed'],
  ['location stop', (f: Awaited<ReturnType<typeof fixture>>) => f.stop(), 'location_sharing_inactive'],
  ['location movement', (f: Awaited<ReturnType<typeof fixture>>) => f.update(11), 'location_moved_too_far'],
  ['location expiry', (f: Awaited<ReturnType<typeof fixture>>) => f.advance(91_000), 'location_sharing_inactive'],
  ['pairing revocation', (f: Awaited<ReturnType<typeof fixture>>) => f.revoke(), 'location_sharing_inactive'],
] as const) test(`${kind} while the bridge is queued prevents the entire combined answer`, async t => {
  const f = await fixture(t), p = {...f.receipts(), disposition: 'announce', utterance_id: f.question, text: 'Must not be stored'};
  const hold = await f.holdBridge();
  const pending = f.call('respond_to_context', p); await settle(); await change(f);
  hold.release(); await hold.pending;
  const result = await pending; assert.equal(result.error.data.reason, expected);
  assert.equal(f.bridge.history().find(x => x.id === f.question)!.reply, undefined);
  assert.equal(f.bridge.outboundHistory().length, 0);
});

test('silence writes nothing and reserves a location activity while leaving a question independent', async t => {
  const f = await fixture(t), refs = f.receipts();
  const before = f.bridge.history();
  const silent = await f.call('respond_to_context', {...refs, disposition: 'silent'});
  assert.equal(silent.result.structuredContent.stored_for_g2, false); assert.deepEqual(f.bridge.history(), before);
  const proactive = await f.call('respond_to_context', {...refs, disposition: 'announce', text: 'Past places'});
  assert.equal(proactive.error.data.reason, 'context_decision_conflict');
  const answer = await f.call('respond_to_context', {...refs, health_read_ids: [(f.health.read({categories: ['sleep']}) as any).read_id], disposition: 'announce', utterance_id: f.question, text: 'An answer'});
  assert.equal(answer.result.structuredContent.stored_for_g2, true);
  assert.equal((await f.call('respond_to_context', {...refs, disposition: 'silent', utterance_id: f.question})).error.data.reason, 'invalid_arguments');
});

for (const withLocation of [false, true]) {
  test(`one occurrence stores one history-informed message across MCP retries and rereads, location=${withLocation}`, async t => {
    const f = await fixture(t);
    if (!withLocation) f.stop();
    const call = async (name: string, args: unknown = {}) => (await f.call(name, args)).result.structuredContent;
    const read = async () => (await call('get_location_history')).response_context.arguments;
    const position = withLocation ? (await call('get_location_context')).response_context.arguments : {};
    const first = {activity_id: 'walk/2026-11-14T12:00Z', ...position, ...await read(), disposition: 'announce', text: 'The book fair is open this afternoon.'};
    const fresh = {...first, ...await read()};
    assert.notDeepEqual(fresh.history_context_ids, first.history_context_ids);
    const sent = await f.call('respond_to_context', first);
    assert.equal(sent.result.structuredContent.stored_for_g2, true);
    assert.equal(sent.result.structuredContent.physical_display_confirmed, false);
    const [retry, reread] = await Promise.all([f.call('respond_to_context', first), f.call('respond_to_context', fresh)]);
    assert.deepEqual(retry, sent);
    assert.equal(reread.error.data.reason, 'context_decision_conflict');
    assert.equal((await f.call('respond_to_context', {...fresh, text: 'Try the book fair today.'})).error.data.reason, 'context_decision_conflict');
    assert.equal(f.bridge.outboundHistory().length, 1);
    const recent = await call('get_recent_announcements');
    assert.deepEqual(recent.messages, [{text: first.text, created_at: f.bridge.outboundHistory()[0].createdAt}]);
    assert.deepEqual((await call('get_location_context')).recent_announcements, [first.text]);
  });
}

test('independent home activities can stay quiet, send a first suggestion, then send only a change', async t => {
  const f = await fixture(t);
  f.stop();
  const read = async () => (await f.call('get_location_history', {})).result.structuredContent.response_context.arguments;
  const decide = async (activity_id: string, text?: string) => f.call('respond_to_context', {
    ...await read(), activity_id, disposition: text ? 'announce' : 'silent', ...(text ? {text} : {}),
  });
  assert.equal((await decide('rain')).result.structuredContent.stored_for_g2, false);
  assert.equal((await decide('rain', 'A conflicting decision')).error.data.reason, 'context_decision_conflict');
  assert.equal((await decide('clear', 'It is a good time for the canal loop.')).result.structuredContent.stored_for_g2, true);
  assert.equal((await decide('unchanged')).result.structuredContent.stored_for_g2, false);
  assert.equal((await decide('earlier-rain', 'For that walk, leave before three.')).result.structuredContent.stored_for_g2, true);
  assert.deepEqual(f.bridge.outboundHistory().map(m => m.reply), ['It is a good time for the canal loop.', 'For that walk, leave before three.']);
});

for (const action of ['disable', 'delete']) {
  test(`history ${action} fences queued and repeated announcements, recent text and new reads`, async t => {
    const f = await fixture(t);
    f.stop();
    const {response_context} = (await f.call('get_location_history', {})).result.structuredContent;
    const decision = {...response_context.arguments, activity_id: 'occasion-one', disposition: 'announce', text: 'The small market opens soon.'};
    assert.equal((await f.call('respond_to_context', decision)).result.structuredContent.stored_for_g2, true);
    const hold = await f.holdBridge();
    const queued = f.call('respond_to_context', {...decision, activity_id: 'occasion-two', text: 'Queued second opportunity.'});
    await settle();
    f.historyControl(action);
    hold.release();
    await hold.pending;
    assert.equal((await queued).error.data.reason, 'history_access_changed');
    assert.equal((await f.call('respond_to_context', decision)).error.data.reason, 'history_access_changed');
    assert.equal((await f.call('get_location_history', {})).result.structuredContent.status, 'unavailable');
    assert.deepEqual((await f.call('get_recent_announcements', {})).result.structuredContent.messages, []);
    f.historyControl('enable');
    assert.deepEqual((await f.call('get_location_context', {})).result.structuredContent.recent_announcements, []);
    assert.deepEqual(f.bridge.outboundHistory().map(m => m.reply), [decision.text]);
  });
}

test('recent messages cross response routes, exclude linked replies and reset for a newly verified conversation', async t => {
  const f = await fixture(t);
  const {context_id} = f.receipts();
  const read = async () => (await f.call('get_recent_announcements', {})).result.structuredContent.messages;
  await f.call('respond_to_location', {context_id, disposition: 'announce', text: 'The arcade is open.'});
  f.update(11);
  assert.deepEqual((await f.call('get_location_context', {})).result.structuredContent.recent_announcements, ['The arcade is open.']);
  for (let index = 1; index <= 5; index++) await f.call('send_message_to_g2', {message_id: randomUUID(), text: 'Suggestion ' + index});
  await f.call('send_message_to_g2', {message_id: randomUUID(), utterance_id: f.question, text: 'A private answer.'});
  await f.call('send_message_to_g2', {message_id: randomUUID(), utterance_id: f.question, text: 'A follow-up.'});
  assert.deepEqual((await read()).map((m: {text: string}) => m.text), Array.from({length: 5}, (_, index) => 'Suggestion ' + (index + 1)));
  const subscription = {name: 'utterance.created', arguments: {session_id: 'personal-g2'}};
  await f.bridge.unsubscribe({...subscription, delivery: {mode: 'webhook', url: 'https://callback.example.test/events'}});
  assert.deepEqual(await read(), []);
  await f.bridge.subscribe({...subscription, delivery: {mode: 'webhook', url: 'https://callback.example.test/other', secret: 'whsec_' + randomBytes(32).toString('base64')}});
  assert.deepEqual(await read(), []);
  assert.ok(f.bridge.outboundHistory().some(message => message.reply === 'Suggestion 1'));
});

test('unused unavailable sources do not block a health-only proactive suggestion, but attached clock history does', async t => {
  const f = await fixture(t), clockRead = (f.health.read({categories: ['heart_rate']}) as any).read_id;
  f.stop(); f.historyControl('disable');
  const old = await f.call('respond_to_context', {health_read_ids: [clockRead], disposition: 'announce', text: 'Old clock association'});
  assert.equal(old.error.data.reason, 'history_access_changed');
  const fresh = (f.health.read({categories: ['heart_rate']}) as any).read_id;
  const p = {health_read_ids: [fresh], disposition: 'announce', text: 'A useful Polar suggestion without place or clock claims'};
  assert.equal((await f.call('respond_to_context', p)).result.structuredContent.stored_for_g2, true);
  f.advance(300_001);
  assert.equal((await f.call('respond_to_context', p)).error.data.reason, 'health_access_changed');
});

test('specified weather combines without current location and rechecks consent at commit', async t => {
  const f = await fixture(t); f.stop();
  const weather = (await f.call('get_weather_context', {mode: 'specified', place: {latitude: 30, longitude: 40,
    label: 'Fixture', source: 'user_provided', reference: 'Fixture request'}})).result.structuredContent;
  const p = {weather_read_ids: [weather.weather_read_id], health_read_ids: [(f.health.read({categories: ['sleep']}) as any).read_id],
    disposition: 'announce', utterance_id: f.question, text: 'Specified place answer'};
  const hold = await f.holdBridge(), pending = f.call('respond_to_context', p); await settle(); f.weatherControl(false); hold.release(); await hold.pending;
  assert.equal((await pending).error.data.reason, 'weather_disabled');
  assert.equal(f.bridge.history().find(x => x.id === f.question)!.reply, undefined);
});

test('explicit weather and mobility receipts cannot be detached from their location', async t => {
  const f = await fixture(t);
  const w = (await f.call('get_weather_context', {mode: 'current'})).result.structuredContent;
  const m = (await f.call('get_mobility_context', {context_id: w.context_id, walking: false, terrain: true})).result.structuredContent;
  for (const refs of [{weather_read_ids: [w.weather_read_id]}, {mobility_read_ids: [m.mobility_read_id]}]) {
    assert.equal((await f.call('respond_to_context', {...refs, disposition: 'silent'})).error.data.reason, 'invalid_arguments');
  }
  f.restartLocation();
  assert.equal((await f.call('respond_to_context', {context_id: f.location.read().context!.context_id,
    mobility_read_ids: [m.mobility_read_id], disposition: 'announce', text: 'Old route'})).error.data.reason, 'mobility_context_unknown');
});

test('unknown questions never turn combined answers into proactive sends; malformed inputs stay private', async t => {
  const f = await fixture(t), p = {...f.receipts(), disposition: 'announce', utterance_id: randomUUID(), text: 'Unknown question'};
  assert.equal((await f.call('respond_to_context', p)).error.data.reason, 'utterance_unknown');
  assert.equal(f.bridge.outboundHistory().length, 0);
  for (const args of [{disposition: 'announce', text: 'no receipts'}, {health_read_ids: ['PRIVATE BAD ID'], disposition: 'silent'},
    {...p, extra: 'PRIVATE BAD FIELD'}, {...p, health_read_ids: Array(9).fill(randomUUID())}]) {
    const r = await f.call('respond_to_context', args); assert.equal(r.error.data.reason, 'invalid_arguments');
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE BAD/);
  }
});

test('one location decision survives changed receipt sets and still permits a new location', async t => {
  const f = await fixture(t), refs = f.receipts();
  const p = {context_id: refs.context_id, health_read_ids: refs.health_read_ids, disposition: 'silent'};
  const first = await f.call('respond_to_context', p);
  assert.equal(first.result.structuredContent.stored_for_g2, false);
  assert.deepEqual(await f.call('respond_to_context', p), first);
  const refreshed = (f.health.read({categories: ['sleep']}) as any).read_id;
  for (const changed of [
    {...p, health_read_ids: [refreshed]},
    {...p, health_read_ids: [refreshed], disposition: 'announce', text: 'Duplicate interruption'},
    {context_id: refs.context_id, disposition: 'announce', text: 'Dropped the health receipt'},
  ]) assert.equal((await f.call('respond_to_context', changed)).error.data.reason, 'context_decision_conflict');
  assert.equal(f.bridge.outboundHistory().length, 0);
  f.update(11);
  assert.equal((await f.call('respond_to_context', {context_id: f.location.read().context!.context_id,
    disposition: 'announce', text: 'A different location decision'})).result.structuredContent.stored_for_g2, true);
  assert.equal(f.bridge.outboundHistory().length, 1);
});

for (const firstRoute of ['respond_to_context', 'respond_to_location']) {
  test(`${firstRoute} prevents a competing decision through the other route`, async t => {
    const f = await fixture(t), {context_id} = f.receipts();
    const secondRoute = firstRoute === 'respond_to_context' ? 'respond_to_location' : 'respond_to_context';
    const p = {context_id, disposition: 'silent'};
    const first = await f.call(firstRoute, p);
    assert.equal(first.result.structuredContent.stored_for_g2, false);
    assert.deepEqual(await f.call(firstRoute, p), first);
    const conflict = await f.call(secondRoute, {context_id, disposition: 'announce', text: 'Second decision'});
    assert.ok(conflict.error); assert.match(conflict.error.data.reason, /conflict/);
    assert.equal(f.bridge.outboundHistory().length, 0);
  });
  test(`${firstRoute} serializes a queued announcement against the other route`, async t => {
    const f = await fixture(t), {context_id} = f.receipts();
    const secondRoute = firstRoute === 'respond_to_context' ? 'respond_to_location' : 'respond_to_context';
    const hold = await f.holdBridge();
    const first = f.call(firstRoute, {context_id, disposition: 'announce', utterance_id: f.question, text: 'First answer'});
    await settle();
    const second = f.call(secondRoute, {context_id, disposition: 'announce', utterance_id: f.question, text: 'Competing answer'});
    await settle(); hold.release(); await hold.pending;
    assert.equal((await first).result.structuredContent.stored_for_g2, true);
    assert.match((await second).error.data.reason, /conflict/);
    assert.equal(f.bridge.history().find(x => x.id === f.question)!.reply, 'First answer');
    assert.equal(f.bridge.outboundHistory().length, 0);
    assert.equal(f.location.status().locationAnnouncementCount, 1);
  });
}

for (const firstRoute of ['respond_to_context', 'respond_to_health']) {
  test(`${firstRoute} owns the health read across silence and route changes`, async t => {
    const f = await fixture(t), read = (f.health.read({categories: ['sleep']}) as any).read_id;
    const args = (route: string) => route === 'respond_to_health' ? {read_id: read} : {health_read_ids: [read]};
    const secondRoute = firstRoute === 'respond_to_health' ? 'respond_to_context' : 'respond_to_health';
    const p = {...args(firstRoute), disposition: 'silent'};
    const first = await f.call(firstRoute, p); assert.ok(first.result);
    assert.deepEqual(await f.call(firstRoute, p), first);
    const second = await f.call(secondRoute, {...args(secondRoute), disposition: 'announce', text: 'Reversed decision'});
    assert.ok(second.error); assert.equal(f.bridge.outboundHistory().length, 0);
  });
  test(`${firstRoute} serializes concurrent health answers across routes`, async t => {
    const f = await fixture(t), read = (f.health.read({categories: ['sleep']}) as any).read_id;
    const args = (route: string) => route === 'respond_to_health' ? {read_id: read} : {health_read_ids: [read]};
    const secondRoute = firstRoute === 'respond_to_health' ? 'respond_to_context' : 'respond_to_health';
    const hold = await f.holdBridge();
    const first = f.call(firstRoute, {...args(firstRoute), disposition: 'announce', utterance_id: f.question, text: 'One health answer'});
    await settle();
    const second = f.call(secondRoute, {...args(secondRoute), disposition: 'announce', utterance_id: f.question, text: 'Duplicate health answer'});
    await settle(); hold.release(); await hold.pending;
    assert.equal((await first).result.structuredContent.stored_for_g2, true);
    assert.ok((await second).error);
    assert.equal(f.bridge.history().find(x => x.id === f.question)!.reply, 'One health answer');
    assert.equal(f.bridge.outboundHistory().length, 0);
  });
}

test('combined decisions reserve every used health read, not just the first', async t => {
  const f = await fixture(t), reads = ['sleep', 'activity'].map(category => (f.health.read({categories: [category]}) as any).read_id);
  const p = {health_read_ids: reads, disposition: 'announce', utterance_id: f.question, text: 'Both health reads'};
  const first = await f.call('respond_to_context', p); assert.equal(first.result.structuredContent.stored_for_g2, true);
  assert.deepEqual(await f.call('respond_to_context', {...p, health_read_ids: [...reads].reverse()}), first);
  for (const read of reads) {
    assert.ok((await f.call('respond_to_health', {read_id: read, disposition: 'announce', text: 'Another use'})).error);
    assert.equal((await f.call('respond_to_context', {health_read_ids: [read], disposition: 'silent'})).error.data.reason, 'context_decision_conflict');
  }
  assert.equal(f.bridge.outboundHistory().length, 0);
});

test('archived weather and route receipts support an activity or a question without current location', async t => {
  const f = await fixture(t);
  const responder = new ContextResponder(f.bridge.sendMessage.bind(f.bridge));
  const a = randomUUID(), b = randomUUID(), unknown = randomUUID();
  const sources = {archives: {responseContext(id: string) {
    return id === a || id === b ? {owner, guard: () => true} : undefined;
  }}};
  await assert.rejects(responder.respond({archive_read_ids:[unknown], disposition:'silent'}, sources), {reason: 'archive_context_unknown'});
  const silent = await responder.respond({archive_read_ids:[a,b], disposition:'silent'}, sources);
  assert.deepEqual(silent, {disposition:'silent', stored_for_g2:false});
  await assert.rejects(responder.respond({archive_read_ids:[a], disposition:'announce', text:'Unsolicited'}, sources), {reason: 'activity_id_required'});
  const reply = {archive_read_ids:[a,b], disposition:'announce', text:'This was the earlier forecast.', utterance_id:f.question};
  const sent = await responder.respond(reply, sources);
  assert.deepEqual(await responder.respond({...reply, archive_read_ids:[b,a]}, sources), sent);
  assert.equal(f.bridge.history().find(q => q.id === f.question)?.reply, reply.text);
  assert.equal(f.bridge.outboundHistory().length, 0);
  const walk = {activity_id:'afternoon-walk/2026-11-14T12:00Z', archive_read_ids:[a,b], disposition:'announce', text:'There is time for the riverside loop.'};
  assert.deepEqual(await responder.respond(walk, sources), await responder.respond(walk, sources));
  assert.equal(f.bridge.outboundHistory().length, 1);
});

test('existing receipt sets retain their persisted v1 retry identity when archive receipts are added to the protocol', async () => {
  const responder = new ContextResponder(async (input, guard) => {
    assert.ok(guard?.());
    const {message_id} = input as {message_id: string};
    return {message_id, stored_for_g2: true, physical_display_confirmed: false};
  });
  const history = {read: () => undefined, responseGuard: () => () => true, historyOwner: () => owner};
  const fields = {history_context_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], disposition: 'announce',
    utterance_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', text: 'Fixture reply'};
  const old = await responder.respond(fields, {history});
  assert.deepEqual(old, {message_id: 'a4c6feb2-b43b-812e-be3c-e939baa0e24d', stored_for_g2: true, physical_display_confirmed: false});
  const archives = {responseContext: () => ({owner, guard: () => true})};
  const expanded = await responder.respond({...fields, archive_read_ids: [randomUUID()]}, {history, archives});
  assert.notDeepEqual(expanded, old);
});

test('archive responses enforce the same owner with other archive, history, Polar, live location and specified weather receipts', async t => {
  const f = await fixture(t);
  const responder = new ContextResponder(f.bridge.sendMessage.bind(f.bridge));
  const same = randomUUID(), other = randomUUID();
  const sources = {locations: f.location, health: f.health, history: f.history, weather: f.weather,
    archives: {responseContext(id: string) { return {owner: id === other ? 'b'.repeat(64) : owner, guard: () => true}; }}};
  const refs = f.receipts();
  const place = {latitude: 1, longitude: 2, label: 'Fixture', source: 'user_provided', reference: 'Fixture place'};
  const weather = (await f.call('get_weather_context', {mode: 'specified', place})).result.structuredContent;
  for (const receipt of [
    {archive_read_ids: [other,same]}, {archive_read_ids: [other], history_context_ids: refs.history_context_ids},
    {archive_read_ids: [other], health_read_ids: refs.health_read_ids}, {archive_read_ids: [other], context_id: refs.context_id},
    {archive_read_ids: [other], weather_read_ids: [weather.weather_read_id]},
  ]) await assert.rejects(responder.respond({...receipt, disposition: 'silent'}, sources), {reason: 'context_access_changed'});

  let valid = true;
  const guarded = {...sources, archives: {responseContext: () => ({owner, guard: () => valid})}};
  const hold = await f.holdBridge();
  const pending = responder.respond({archive_read_ids: [same], health_read_ids: refs.health_read_ids, disposition: 'announce',
    utterance_id: f.question, text: 'Revoked during delivery.'}, guarded);
  await settle();
  valid = false;
  hold.release(); await hold.pending;
  await assert.rejects(pending, {reason: 'context_access_changed'});
  assert.equal(f.bridge.history().find(q => q.id === f.question)?.reply, undefined);
});
