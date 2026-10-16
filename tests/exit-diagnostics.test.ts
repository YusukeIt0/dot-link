import test from 'node:test';
import assert from 'node:assert/strict';
import {ExitDiagnostics} from '../src/exit-diagnostics.ts';
test('disabled diagnostics never access storage or output', () => {
  const fail = () => { throw new Error('Must not access'); };
  new ExitDiagnostics({enabled: false, storage: fail, changed: fail, log: fail}).record('boot');
});
test('diagnostics preserve prior runs, bound retained events, and drop extra payload fields', () => {
  let data = JSON.stringify([{run: 'old', at: 0, event: 'system-exit', private: 'secret'}, {run: 'old', at: 1, event: 'secret'}]);
  let text = '';
  const storage = () => ({getItem: () => data, setItem: (_: string, value: string) => {data = value;}});
  const probe = new ExitDiagnostics({enabled: true, storage, changed: value => {text = value;}, log() {}, now: () => 1000});
  probe.record('boot'); assert.match(text, /old system-exit/); assert.ok(!data.includes('secret'));
  for (let i = 0; i < 100; i++) probe.record('share-heartbeat');
  assert.equal(JSON.parse(data).length, 48);
  new ExitDiagnostics({enabled: true, storage, changed: value => {text = value;}, log() {}, now: () => 2000}).record('boot');
  assert.equal(new Set(JSON.parse(data).map((r: {run: string}) => r.run)).size, 2);
});
test('unavailable storage and broken rendering never prevent cleanup', () => {
  const probe = new ExitDiagnostics({enabled: true, storage: () => {throw Error('denied');}, changed() {throw Error('gone');}, log() {}});
  assert.doesNotThrow(() => probe.record('system-exit'));
  assert.doesNotThrow(() => probe.record('stop-session'));
});

test('exit envelopes remain visible even if routing would prefer another envelope or app already stopped', () => {
  const map = new Map<string, string>();
  const probe = new ExitDiagnostics({enabled: true,
    storage: () => ({getItem: k => map.get(k) ?? null, setItem: (k, v) => {map.set(k, v);}}), changed() {}, log() {}});
  probe.observe({sysEvent: {eventType: 0}, textEvent: {eventType: 7}}, true);
  probe.observe({sysEvent: {systemExitReasonCode: 1}}, false);
  assert.deepEqual(JSON.parse(map.get('dot-exit-check-v1')!).map((r: {event: string}) => r.event), ['text-exit', 'exit-after-stop', 'exit-reason']);
});
