import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceInfo, EvenAppMethod } from '@evenrealities/even_hub_sdk';
import { GlassesAvailability } from '../src/g2-availability.ts';
import { G2DeliveryAvailability } from '../server/g2-availability.ts';

test('a settled closed case cannot assert availability; positive wear distinguishes a desk', async () => {
  const device = new GlassesAvailability();
  const sample = (flags: Record<string, unknown>, model = 'g2', connectType = 'connected') =>
    device.read({callEvenApp: async method => {
      assert.equal(method, EvenAppMethod.GetGlassesInfo); return {model, status: {connectType, ...flags}};
    }});
  assert.equal(DeviceInfo.fromJson({model:'g2', status:{connectType:'connected'}}).status.isInCase, false);
  assert.equal(await sample({}), 'unknown');
  assert.equal(await sample({isInCase: 'false'}), 'unknown');
  assert.equal(await sample({isInCase: false, isWearing: 'true'}), 'unknown');
  assert.equal(await sample({isInCase: false, isWearing: true}, 'ring1'), 'unknown');
  assert.equal(await sample({isInCase: false, isWearing: false}), 'unknown');
  assert.equal(await sample({isInCase: true, isWearing: false, isCharging: false}), 'unavailable');
  assert.equal(await sample({isInCase: false, isWearing: false, isCharging: false}), 'unknown');
  assert.equal(await sample({isInCase: false, isWearing: true, isCharging: true}), 'unavailable');
  assert.equal(await sample({isInCase: false, isWearing: true, isCharging: 'false'}), 'unknown');
  assert.equal(await sample({isInCase: true, isWearing: true}), 'unavailable');
  assert.equal(await sample({isInCase: false, isWearing: true}), 'available');
  device.cancelReading(); // A system menu leaves the same G2 connected.
  assert.equal(await sample({isInCase: false, isWearing: false}), 'unavailable');
  assert.equal(await sample({isInCase: false}), 'unknown');
  assert.equal(await sample({isInCase: false, isWearing: true}, 'g2', 'disconnected'), 'unknown');
  assert.equal(await sample({isInCase: false}), 'unknown');
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
  assert.equal(await read(false), 'unknown');
  finishAgain(sample(false));
  await second;
  assert.equal(await read(false), 'unknown');
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
  let posts = 0, onRead!: () => void;
  const delayed = new Promise<'available'>(resolve => {onRead = () => resolve('available');});
  const task = device.answer({id:'first'}, () => delayed, () => true, async () => {posts++;});
  device.invalidate(); onRead(); await task;
  assert.equal(posts, 0);
  for (let i = 0; i < 2; i++)
    await device.answer({id:'fresh'}, async () => 'unknown', () => true, async () => {posts++;});
  assert.equal(posts, 1);
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
  assert.equal((await replacement).state(), 'unknown');
  assert.equal(mac.respond('first','session-a',{...old,state:'available'}), false);
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
  const mac = new G2DeliveryAvailability(() => true, () => performance.now(), 10);
  mac.observe('paired', 'older');
  assert.equal((await mac.check()).state(), 'unknown');
  assert.equal(mac.challenge('paired','older'), undefined);
  mac.close();
});
