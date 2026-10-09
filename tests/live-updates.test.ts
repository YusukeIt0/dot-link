import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { LiveUpdates } from '../src/live-updates.ts';

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
