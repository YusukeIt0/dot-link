import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceInfo, EvenAppMethod } from '@evenrealities/even_hub_sdk';
import { GlassesAvailability } from '../src/g2-availability.ts';
import { commitDelivery, G2DeliveryAvailability } from '../server/g2-availability.ts';

test('only the connected G2 case flag selects Wearing or In case, including on a fresh launch', async () => {
  const device = new GlassesAvailability();
  const sample = (flags: Record<string, unknown>, model = 'g2', connectType = 'connected') =>
    device.read({callEvenApp: async method => {
      assert.equal(method, EvenAppMethod.GetGlassesInfo); return {model, status: {connectType, ...flags}};
    }});
  assert.equal(DeviceInfo.fromJson({model:'g2', status:{connectType:'connected'}}).status.isInCase, false);
  assert.equal(await sample({}), 'unknown');
  assert.equal(await sample({isInCase: 'false'}), 'unknown');
  assert.equal(await sample({isWearing: true}), 'unknown');
  assert.equal(await sample({isInCase: false, isWearing: 'true'}), 'available');
  assert.equal(await sample({isInCase: false, isWearing: true}, 'ring1'), 'unknown');
  assert.equal(await sample({isInCase: false, isWearing: false}), 'available');
  assert.equal(await sample({isInCase: true, isWearing: false, isCharging: false}), 'unavailable');
  assert.equal(await sample({isInCase: false, isWearing: false, isCharging: false}), 'available');
  assert.equal(await sample({isInCase: false, isWearing: true, isCharging: true}), 'unknown');
  assert.equal(await sample({isInCase: true, isWearing: true}), 'unavailable');
  assert.equal(await sample({isInCase: false, isWearing: true}), 'available');
  device.cancelReading(); // A system menu leaves the same G2 connected.
  assert.equal(await sample({isInCase: false, isWearing: false}), 'available');
  assert.equal(await sample({isInCase: false}), 'available');
  assert.equal(await sample({isInCase: false, isWearing: true}, 'g2', 'disconnected'), 'unknown');
  assert.equal(await sample({isInCase: false}), 'available');
});

test('the phone follows the raw case field across conflicting signals, unreadable samples and disconnection', async () => {
  const device = new GlassesAvailability(() => {});
  const sample = (status: Record<string, unknown>) => ({model: 'g2', sn: 'glasses', status: {connectType: 'connected', ...status}});
  const read = (status: Record<string, unknown>) => device.read({callEvenApp: async () => sample(status)});
  assert.equal(await read({isInCase: false, isCharging: true}), 'unknown');
  assert.equal(device.reportedCasePosition, 'unknown');
  await read({isWearing: true});
  assert.equal(device.reportedCasePosition, 'unknown');
  await read({isInCase: true});
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => {finish = resolve;});
  device.statusChanged({callEvenApp: () => pending}, {sn: 'glasses', connectType: 'disconnected'});
  assert.equal(device.reportedCasePosition, 'unknown');
  finish(sample({isInCase: false}));
  await new Promise<void>(resolve => setImmediate(resolve)); // Finish the event read before sampling a reconnected G2.
  assert.equal(device.reportedCasePosition, 'unknown');
  device.statusChanged({callEvenApp: async () => sample({isInCase: false})}, {sn: 'glasses', connectType: 'connected'});
  await read({isInCase: false});
  assert.equal(device.reportedCasePosition, 'outside');
  await device.read({callEvenApp: async () => {throw new Error('Host unavailable');}});
  assert.equal(device.reportedCasePosition, 'unknown');
});

test('a delivery-time getter can confirm an overlapping removal event without borrowing an old case reading', async () => {
  const availability = new GlassesAvailability();
  const sample = (inside: boolean) => ({model: 'g2', sn: 'fixture', status: {connectType: 'connected', isInCase: inside, isCharging: inside, isWearing: false}});
  const read = (inside: boolean) => availability.read({callEvenApp: async () => sample(inside)});
  const event = {...sample(false).status, sn: 'fixture'};
  assert.equal(await read(true), 'unavailable');
  let finish!: (value: unknown) => void;
  const native = new Promise(resolve => {finish = resolve;});
  availability.statusChanged({callEvenApp: () => native}, event);
  assert.equal(await read(false), 'available');
  finish(sample(true));
  await native;
  assert.equal(await read(false), 'available');

  assert.equal(await read(true), 'unavailable');
  let finishAgain!: (value: unknown) => void;
  const second = new Promise(resolve => {finishAgain = resolve;});
  availability.statusChanged({callEvenApp: () => second}, event);
  assert.equal(await read(true), 'unavailable');
  assert.equal(await read(false), 'available');
  finishAgain(sample(false));
  await second;
  assert.equal(await read(false), 'available');
});

test('late native reads and abandoned companion requests cannot revive an old state', async () => {
  const device = new GlassesAvailability();
  let finish!: (value: unknown) => void;
  const raw = new Promise<unknown>(resolve => {finish = resolve;});
  const pending = device.read({callEvenApp: () => raw});
  const nowInCase = {model: 'g2', status: {connectType: 'connected', isInCase: true}};
  assert.equal(await device.read({callEvenApp: async () => nowInCase}), 'unavailable');
  finish({model:'g2', status:{connectType:'connected', isInCase:false, isWearing:true}});
  assert.equal(await pending, 'unknown');
  assert.equal(device.reportedCasePosition, 'inside');
  let posts = 0, onRead!: () => void;
  const delayed = new Promise<'available'>(resolve => {onRead = () => resolve('available');});
  const task = device.answer({id:'first'}, () => delayed, () => true, async () => {posts++;});
  device.invalidate(); onRead(); await task;
  assert.equal(device.reportedCasePosition, 'unknown');
  assert.equal(posts, 0);
  for (let i = 0; i < 2; i++)
    await device.answer({id:'fresh'}, async () => 'unknown', () => true, async () => {posts++;});
  assert.equal(posts, 1);
});

test('only the current G2 contributes in-flight events, independent of accessory arrival order', async () => {
  const outside = {connectType:'connected', isInCase:false, isCharging:false, isWearing:false};
  const removed = {...outside, sn:'glasses'};
  const closing = {...removed, isInCase:true, isCharging:true};
  const ring = {...outside, sn:'ring'};
  const chargingRing = {...ring, isCharging:true};
  for (const [events, expected] of [
    [[removed,ring], 'available'], [[ring,removed], 'available'],
    [[removed,chargingRing], 'available'], [[chargingRing,removed], 'available'],
    [[removed,{...ring,connectType:'disconnected'}], 'available'],
    [[removed,chargingRing,closing], 'unknown'], [[closing,ring,removed], 'available'],
    [[removed,{...closing,sn:''}], 'unknown'],
    [[removed,...Array.from({length:8}, (_, i) => ({...chargingRing,sn:'accessory-'+i}))], 'available'],
  ] as const) {
    const device = new GlassesAvailability();
    const inside = {model:'g2', sn:'glasses', status:closing};
    const onDesk = {model:'g2', sn:'glasses', status:outside};
    assert.equal(await device.read({callEvenApp:async () => inside}), 'unavailable');
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => {finish = resolve;});
    for (const event of events) device.statusChanged({callEvenApp:() => pending}, event);
    assert.equal(await device.read({callEvenApp:async () => onDesk}), expected, JSON.stringify(events));
    finish(onDesk);
    await pending;
  }
});

test('routing observes only an unexpired challenge of one current owner and runtime', async () => {
  const permitted = new Map([['first','session-a'], ['second','session-b']]);
  let now = 100;
  const mac = new G2DeliveryAvailability((owner, session) => permitted.get(owner) === session, () => now, 2500);
  assert.equal((await mac.check()).state(), 'unknown');
  mac.observe('first', 'session-a');
  const first = mac.check(), shared = mac.check('first');
  const challenge = mac.challenge('first', 'session-a')!;
  assert.ok(challenge);
  assert.equal(mac.respond('second','session-b',{...challenge,state:'available'}), false);
  assert.equal(mac.respond('first','session-a',{...challenge,state:'available', sn:'fixture'}), false);
  assert.equal(mac.respond('first','session-a',{...challenge,state:'available'}), true);
  const anonymous = await first, paired = await shared;
  assert.equal(anonymous.state(), 'available'); assert.equal(paired.state(), 'available');
  assert.equal(mac.respond('first','session-a',{...challenge,state:'available'}), false);
  mac.observe('second','session-b');
  assert.equal(anonymous.state(), 'unknown');
  assert.equal(paired.state(), 'available');
  assert.equal((await mac.check()).state(), 'unknown');
  const replacement = mac.check('first'), old = mac.challenge('first','session-a')!;
  assert.equal(paired.state(), 'unknown');
  permitted.set('first','session-new');
  mac.observe('first','session-new');
  assert.equal(mac.respond('first','session-a',{...old,state:'available'}), false);
  await new Promise<void>(resolve => setImmediate(resolve));
  const recovered = mac.challenge('first', 'session-new');
  assert.ok(recovered && recovered.id !== old.id);
  assert.equal(mac.respond('first','session-new',{...recovered,state:'unavailable'}), true);
  assert.equal((await replacement).state(), 'unavailable');
  const absent = mac.check('first');
  const late = mac.challenge('first','session-new')!;
  now += 2500;
  assert.equal(mac.respond('first','session-new',{...late,state:'available'}), false);
  mac.close(); assert.equal((await absent).state(),'unknown');
  assert.deepEqual((await mac.check()).state(), 'unknown');
  mac.observe('first','session-new'); now += 25_000;
  assert.equal((await mac.check()).state(),'unknown');
});

test('a sleeping or older companion cannot prolong the send by holding the long poll', async () => {
  const mac = new G2DeliveryAvailability(() => true, () => performance.now(), 10, 60, 5);
  mac.observe('paired', 'older');
  assert.equal((await mac.check()).state(), 'unknown');
  assert.equal(mac.challenge('paired','older'), undefined);
  mac.close();
});

test('a reply held in the write queue rechecks the same glasses before choosing a destination', async t => {
  let now = 0;
  const mac = new G2DeliveryAvailability(() => true, () => now);
  t.after(() => mac.close());
  mac.observe('owner', 'phone');
  const first = mac.check('owner');
  const outside = mac.challenge('owner', 'phone')!;
  assert.ok(mac.respond('owner', 'phone', {...outside, state:'available'}));
  const confirmed = await first;
  assert.equal(confirmed.state(), 'available');
  now += 2600; // The first reading expired while an earlier write was in the queue.
  let changed!: () => void;
  const ready = new Promise<void>(resolve => { changed = resolve; });
  const stop = mac.changes.subscribe(changed);
  t.after(stop);
  const pending = commitDelivery(confirmed, action => action(), observation => observation?.state());
  await ready;
  const again = mac.challenge('owner','phone')!;
  assert.notEqual(again.id, outside.id);
  assert.ok(mac.respond('owner','phone',{...again,state:'unavailable'}));
  assert.equal(await pending, 'unavailable');
});
