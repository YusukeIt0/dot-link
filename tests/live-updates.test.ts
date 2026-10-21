import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { LiveUpdates } from '../src/live-updates.ts';
import { reconcileHistory, NewReplyQueue, type HistoryMessage } from '../src/message-history.ts';

test('restart before first snapshot restores the newest of 100 messages without replaying alerts', async t => {
  const calls: {resolve: (value: {revision:string;messages:HistoryMessage[]}) => void}[] = [];
  let messages: HistoryMessage[] = []; let displayed: string | undefined;
  const queue = new NewReplyQueue();
  const loop = new LiveUpdates<{revision:string;messages:HistoryMessage[]}>(() => new Promise(resolve => calls.push({resolve})), (value, initial) => {
    const update = reconcileHistory(messages, value.messages, initial, () => true);
    messages = update.messages;
    if(initial) queue.clear(); else queue.receive(update.replies);
    displayed = initial ? update.displayId : queue.next(messages, undefined, {hidden:false,browsingHistory:false,mayAnnounce:()=>true});
  }, () => assert.fail('no failure expected'));
  t.after(()=>loop.stop());
  loop.start(true); loop.start(); // visibility/online event before initial response
  calls[1].resolve({revision:'restored',messages:Array.from({length:100},(_,i)=>({id:String(i+1),status:'replied',reply:'Fixture reply',createdAt:new Date(i*1000).toISOString()}))});
  await tick();
  assert.equal(displayed, '100'); assert.equal(queue.count, 0);
});

test('reconnect discards late responses from an aborted request and never starts overlapping polls', async () => {
  const calls: { revision?: string; signal: AbortSignal; resolve: (v: { revision: string }) => void }[] = [];
  const received: string[] = [];
  const loop = new LiveUpdates<{ revision: string }>((revision, signal) => new Promise(resolve => { calls.push({ revision, signal, resolve }); }), value => received.push(value.revision), () => assert.fail('no error expected'));
  loop.start(true); assert.equal(calls.length, 1);
  loop.start(false); assert(calls[0].signal.aborted); assert.equal(calls.length, 2);
  calls[0].resolve({ revision: 'stale' }); await tick(); assert.deepEqual(received, []);
  calls[1].resolve({ revision: 'current' }); await tick();
  assert.deepEqual(received, ['current']); assert.equal(calls.length, 3); assert.equal(calls[2].revision, 'current');
  loop.stop(); assert(calls[2].signal.aborted);
  calls[2].resolve({ revision: 'after-stop' }); await tick(); assert.deepEqual(received, ['current']);
});

test('completed restores stay incremental on reconnect; explicit new sessions restore again', async t => {
  const calls: ((value:{revision:string})=>void)[]=[]; const flags:boolean[]=[];
  const loop=new LiveUpdates<{revision:string}>(()=>new Promise(resolve=>calls.push(resolve)),(_value,initial)=>flags.push(initial),()=>assert.fail());
  t.after(()=>loop.stop());
  loop.start(); calls[0]({revision:'first'});await tick();
  loop.start(); calls[2]({revision:'reconnect'});await tick();
  loop.start(true);calls[4]({revision:'new-session'});await tick();
  loop.start(false,'externally-applied');calls[6]({revision:'incremental'});await tick();
  assert.deepEqual(flags,[true,false,true,false]);
});

const microtasks = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function recoveryFixture() {
  const calls: {resolve(value: {revision: string}): void; reject(error: Error): void}[] = [];
  let failures = 0;
  const loop = new LiveUpdates<{revision: string}>(() => new Promise((resolve, reject) => calls.push({resolve, reject})), () => {}, () => failures++);
  return {loop, calls, failures: () => failures};
}
test('brief recovery stays online; a hanging retry becomes visible within the grace interval', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 10000});
  const f = recoveryFixture(); t.after(() => f.loop.stop());
  f.loop.start(); f.calls[0].resolve({revision: 'first'}); await microtasks();
  f.calls[1].reject(new Error('temporary')); await microtasks();
  assert.equal(f.failures(), 0);
  t.mock.timers.tick(1000); await microtasks();
  f.calls[2].resolve({revision: 'recovered'}); await microtasks();
  t.mock.timers.tick(2000); assert.equal(f.failures(), 0);
  f.calls[3].reject(new Error('long outage')); await microtasks();
  t.mock.timers.tick(1000); await microtasks(); // retry now hangs
  t.mock.timers.tick(999); assert.equal(f.failures(), 0);
  t.mock.timers.tick(1); assert.equal(f.failures(), 1);
  t.mock.timers.tick(10000); assert.equal(f.failures(), 1);
});
test('initial failure is immediate; foreground restarts cannot extend the grace and stop removes it', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 10000});
  const f = recoveryFixture(); t.after(() => f.loop.stop());
  f.loop.start(true); f.calls[0].reject(new Error('initial')); await microtasks();
  assert.equal(f.failures(), 1);
  f.loop.start(); f.calls[1].resolve({revision: 'connected'}); await microtasks();
  f.calls[2].reject(new Error('outage')); await microtasks();
  t.mock.timers.tick(1500); await microtasks(); f.loop.start();
  t.mock.timers.tick(499); assert.equal(f.failures(), 1);
  t.mock.timers.tick(1); assert.equal(f.failures(), 2);
  f.calls.at(-1)!.resolve({revision: 'again'}); await microtasks();
  f.calls.at(-1)!.reject(new Error('cancelled outage')); await microtasks();
  f.loop.stop(); t.mock.timers.tick(10000); assert.equal(f.failures(), 2);
});
