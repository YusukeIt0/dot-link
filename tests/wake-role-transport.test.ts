import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWakeDetector } from '../src/wake-detector.ts';

test('role and PCM travel together; restart rejects stale wake results and preserves queue accounting', async () => {
  const savedWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const sent: any[] = [], events: any[] = [];
  let worker: FakeWorker;
  class FakeWorker {
    onmessage?: (event: { data: any }) => void;
    onerror?: () => void;
    onmessageerror?: () => void;
    terminated = false;
    constructor() { worker = this; }
    postMessage(data: any) { sent.push(data); if (data.type === 'init') queueMicrotask(() => this.emit({ type: 'ready' })); }
    emit(data: any) { this.onmessage?.({ data }); }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://example.invalid/' } });
  let detector: Awaited<ReturnType<typeof loadWakeDetector>> | undefined;
  try {
    detector = await loadWakeDetector(event => events.push(event), () => assert.fail('unexpected worker failure'));
    detector.listen();
    const pcm = new Uint8Array([1, 0, 2, 0]);
    detector.append(pcm, 'other'); pcm.fill(0);
    const audio = sent.at(-1);
    assert.equal(audio.role, 'other'); assert.equal(audio.generation, 1);
    assert.deepEqual(audio.pcm, new Uint8Array([1, 0, 2, 0]));
    detector.cancel(); detector.listen();
    worker!.emit({ type: 'wake', generation: 1 });
    assert.deepEqual(events, []);
    detector.append(new Uint8Array(32000), 'self');
    worker!.emit({ type: 'processed', generation: 1, bytes: 32000 });
    assert.equal(sent.at(-1).role, 'self');
    worker!.emit({ type: 'processed', generation: 3, bytes: 32000 });
    detector.append(new Uint8Array(32000));
    assert.equal(sent.at(-1).role, 'unknown'); assert.equal(sent.at(-1).generation, 3);
    worker!.emit({ type: 'wake', generation: 3 });
    assert.deepEqual(events, [{ type: 'wake' }]);
  } finally {
    detector?.dispose();
    if (savedWorker) Object.defineProperty(globalThis, 'Worker', savedWorker); else Reflect.deleteProperty(globalThis, 'Worker');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
