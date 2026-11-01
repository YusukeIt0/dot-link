import test from 'node:test';
import assert from 'node:assert/strict';
import { HistorySharing } from '../src/history-sharing.ts';

test('new companion on old or unknown Mac sends no unsupported history fields or controls', async () => {
  let calls = 0;
  const history = new HistorySharing({target: () => 'mac-a', api: async () => {calls++; return {};}, changed() {}});
  for (const status of [{}, {historyProtocol: 2}, {historyProtocol: 1}, {historyProtocol: 1, historyEpoch: null}]) {
    history.receive(status); assert.equal(history.upload(), undefined); await history.control('enable');
  }
  assert.equal(calls, 0);
});
test('history opt-in remains scoped to its Mac across sparse uploads and stale stops still reach the Mac', async () => {
  let target = 'mac-a', clock = Date.now();
  const history = new HistorySharing({target: () => target, now: () => clock, changed() {}, api: async input => ({historyProtocol: 1, historyEpoch: 'next', historyEnabled: (input as any).action === 'enable'})});
  history.receive({historyProtocol: 1, historyEpoch: 'first', historyEnabled: false});
  assert.equal(history.upload(), undefined); await history.control('enable'); assert.equal(history.upload()?.epoch, 'next');
  target = 'mac-b'; assert.equal(history.upload(), undefined);
  history.receive({historyProtocol: 1, historyEpoch: 'second', historyEnabled: false}); assert.equal(history.upload(), undefined);
  history.receive({historyProtocol: 1, historyEpoch: 'second', historyEnabled: true}); clock += 45_001;
  assert.equal(history.upload()?.epoch, 'second');
  assert.equal(history.status().supported, false);
  clock += 300_000; assert.equal(history.upload()?.epoch, 'second');
  await history.control('disable');
  assert.equal(history.upload(), undefined);
  assert.equal(history.status().historyEnabled, false);
  history.reset(); assert.equal(history.upload(), undefined);
});
test('failed disable is visible and is never reported as remotely revoked; simulation suspends uploads', async () => {
  const history = new HistorySharing({target: () => 'mac-a', changed() {}, api: async () => {throw new Error('offline');}});
  history.receive({historyProtocol: 1, historyEpoch: 'first', historyEnabled: true}); await history.control('disable');
  assert.equal(history.status().failed, true); assert.equal(history.status().historyEnabled, true);
  assert.equal(history.upload(), undefined);
  history.receive({historyProtocol: 1, historyEpoch: 'first', historyEnabled: true, historySimulation: 'walk'});
  assert.equal(history.upload(), undefined);
});

test('stale failed stop is visible and suppresses uploads until a successful explicit enable', async () => {
  let clock = Date.now(), fail = true, changes = 0;
  const status = {historyProtocol: 1, historyEpoch: 'first', historyEnabled: true};
  const history = new HistorySharing({target: () => 'mac-a', now: () => clock, changed() {changes++;}, api: async () => {
    if (fail) throw new Error('offline'); return status;
  }});
  history.receive(status); clock += 60_000;
  await history.control('delete');
  assert.ok(changes > 1); assert.equal(history.status().failed, true); assert.equal(history.upload(), undefined);
  history.reset(); history.receive(status);
  assert.equal(history.status().historyEnabled, true); assert.equal(history.upload(), undefined);
  fail = false; await history.control('enable');
  assert.equal(history.status().failed, false); assert.equal(history.upload()?.epoch, 'first');
  history.reset(); await history.control('disable');
  assert.equal(history.status().failed, true); assert.equal(history.upload(), undefined);
});
test('a delayed consent response cannot alter a different selected Mac', async () => {
  let target = 'mac-a', finish!: (v: unknown) => void;
  const history = new HistorySharing({target: () => target, changed() {}, api: () => new Promise(resolve => {finish = resolve;})});
  history.receive({historyProtocol: 1, historyEpoch: 'first', historyEnabled: false});
  const request = history.control('enable'); target = 'mac-b';
  finish({historyProtocol: 1, historyEpoch: 'late', historyEnabled: true}); await request;
  assert.equal(history.upload(), undefined);
});


test('successful live uploads refresh history when update polling stalls, without inheriting another Mac', () => {
  let target = 'mac-a', clock = Date.now();
  const history = new HistorySharing({target: () => target, now: () => clock, changed() {}, api: async () => ({})});
  const status = {historyProtocol: 1, historyEpoch: 'first', historyEnabled: true};
  history.receive(status);
  clock += 45_001; assert.equal(history.upload()?.epoch, 'first');
  assert.equal(history.status().connected, false);
  history.receiveUpload(status, 'mac-a'); assert.equal(history.upload()?.epoch, 'first');
  clock += 30_000; history.receiveUpload(status, 'mac-a');
  clock += 30_000; assert.equal(history.upload()?.epoch, 'first');
  history.receiveUpload({...status, historyEnabled:false}, 'mac-a'); assert.equal(history.upload(), undefined);
  target = 'mac-b'; history.receiveUpload(status, 'mac-a'); assert.equal(history.upload(), undefined);
  history.receiveUpload({}, 'mac-b'); assert.equal(history.upload(), undefined);
});
