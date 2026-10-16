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
test('native storage restores the previous run across different WebView origins and merges an early new boot', async () => {
  const nativeMap = new Map<string, string>();
  const native = {async getLocalStorage(k: string) {return nativeMap.get(k) ?? '';}, async setLocalStorage(k: string, v: string) {nativeMap.set(k, v); return true;}};
  const make = (now: number) => {
    const local = new Map<string, string>();
    const probe = new ExitDiagnostics({enabled: true, storage: () => ({getItem: k => local.get(k) ?? null, setItem: (k, v) => {local.set(k, v);}}), changed() {}, log() {}, now: () => now});
    return {probe, local};
  };
  const first = make(1000); first.probe.record('system-exit'); await first.probe.attach(native);
  const second = make(2000); second.probe.record('boot'); await second.probe.attach(native);
  const rows = JSON.parse(second.local.get('dot-exit-check-v1')!);
  assert.deepEqual(rows.map((r: {event: string}) => r.event), ['system-exit', 'boot']);
  assert.equal(new Set(rows.map((r: {run: string}) => r.run)).size, 2);
});
test('events arriving during a native save are persisted afterwards, and failed saves are visible', async () => {
  const local = new Map<string, string>(); let text = '', finish: (ok: boolean) => void = () => {};
  const writes: string[] = [];
  const probe = new ExitDiagnostics({enabled: true, storage: () => ({getItem: k => local.get(k) ?? null, setItem: (k, v) => {local.set(k, v);}}), changed: value => {text = value;}, log() {}});
  probe.record('boot');
  const attaching = probe.attach({async getLocalStorage() {return '';}, setLocalStorage(_k, v) {writes.push(v); return new Promise(resolve => {finish = resolve;});}});
  await Promise.resolve(); probe.record('system-exit'); finish(true); await Promise.resolve(); await Promise.resolve();
  assert.equal(writes.length, 2); assert.ok(writes[1].includes('system-exit')); finish(false); await attaching;
  assert.match(text, /native failed/);
});
