import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveQrScanner } from '../src/live-qr.ts';

function fixture() {
  let stops = 0, plays = 0;
  const stream = { getTracks: () => [{ stop: () => { stops++; } }] } as unknown as MediaStream;
  const view = { srcObject: null, pause() {}, async play() { plays++; }, muted: false, playsInline: false } as unknown as HTMLVideoElement;
  return { stream, view, stops: () => stops, plays: () => plays };
}

test('closing while camera permission is pending stops a late stream without displaying it', async () => {
  const f = fixture();
  let approve!: (value: MediaStream) => void;
  const pending = new Promise<MediaStream>(resolve => { approve = resolve; });
  const scanner = new LiveQrScanner(f.view, { getUserMedia: () => pending }, () => 'unused');
  const starting = scanner.start(() => assert.fail('No late QR result'), () => assert.fail('No late error'));
  scanner.stop(); approve(f.stream); await starting;
  assert.equal(f.stops(), 1); assert.equal(f.plays(), 0); assert.equal(f.view.srcObject, null);
});

test('automatic QR acceptance releases the camera and requests no microphone', async () => {
  const f = fixture(); let options: MediaStreamConstraints | undefined, received = '';
  const scanner = new LiveQrScanner(f.view, { getUserMedia: async value => { options = value; return f.stream; } }, () => 'synthetic QR');
  await scanner.start(raw => { received = raw; return true; }, () => assert.fail('Unexpected camera error'));
  assert.deepEqual(options, { audio: false, video: true }); assert.equal(received, 'synthetic QR');
  assert.equal(f.stops(), 1); assert.equal(f.view.srcObject, null);
});

test('an unrelated QR is not accepted; closing still releases the camera', async () => {
  const f = fixture();
  const scanner = new LiveQrScanner(f.view, { getUserMedia: async () => f.stream }, () => 'unrelated QR');
  try {
    await scanner.start(() => false, () => assert.fail('Unexpected camera error'));
    assert.equal(f.stops(), 0); assert.equal(f.view.srcObject, f.stream);
  } finally { scanner.stop(); }
  assert.equal(f.stops(), 1); assert.equal(f.view.srcObject, null);
});

test('permission denial and video failure are reported without leaving tracks running', async () => {
  const f = fixture(); let issue = '';
  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const scanner = new LiveQrScanner(f.view, { getUserMedia: async () => { throw denied; } }, () => undefined);
  await scanner.start(() => false, reason => { issue = reason; });
  assert.equal(issue, 'denied'); assert.equal(f.view.srcObject, null);
  f.view.play = async () => { throw new Error('video failed'); };
  const broken = new LiveQrScanner(f.view, { getUserMedia: async () => f.stream }, () => undefined);
  await broken.start(() => false, reason => { issue = reason; });
  assert.equal(issue, 'failed'); assert.equal(f.stops(), 1); assert.equal(f.view.srcObject, null);
});

test('playback NotAllowedError is distinct from camera denial and a tap retries playback without requesting access again', async () => {
  const f = fixture(); let requests = 0, plays = 0;
  const evidence: { stage: string; error?: string }[] = [], issues: string[] = [];
  f.view.play = async () => { if (++plays === 1) throw Object.assign(new Error('private host text'), { name: 'NotAllowedError' }); };
  const scanner = new LiveQrScanner(f.view, { getUserMedia: async () => { requests++; return f.stream; } }, () => 'valid');
  try {
    await scanner.start(() => true, reason => issues.push(reason), value => evidence.push(value));
    assert.deepEqual(issues, ['playback']);
    assert.deepEqual(evidence.at(-1), { stage: 'playback', error: 'NotAllowedError' });
    assert.equal(f.stops(), 0);
    await scanner.resume();
    assert.equal(requests, 1); assert.equal(plays, 2); assert.equal(f.stops(), 1);
    assert.deepEqual(evidence.at(-1), { stage: 'scanning' });
  } finally { scanner.stop(); }
});

test('camera denial reports request stage and never attempts playback', async () => {
  const f = fixture(); const evidence: { stage: string; error?: string }[] = [];
  const scanner = new LiveQrScanner(f.view, { getUserMedia: async () => { throw Object.assign(new Error('private host text'), { name: 'NotAllowedError' }); } });
  await scanner.start(() => false, reason => assert.equal(reason, 'denied'), value => evidence.push(value));
  assert.deepEqual(evidence.at(-1), { stage: 'request', error: 'NotAllowedError' });
  assert.equal(f.plays(), 0); assert.equal(JSON.stringify(evidence).includes('private'), false);
});

test('closing while awaiting a playback tap stops tracks and prevents later resume', async () => {
  const f = fixture(); let plays = 0;
  f.view.play = async () => { plays++; throw Object.assign(new Error(), { name: 'NotAllowedError' }); };
  const scanner = new LiveQrScanner(f.view, { getUserMedia: async () => f.stream });
  await scanner.start(() => false, () => {});
  scanner.stop(); await scanner.resume();
  assert.equal(plays, 1); assert.equal(f.stops(), 1); assert.equal(f.view.srcObject, null);
});


test('rear-camera selection failure keeps the acquired camera usable without another access request', async () => {
  const f = fixture(); let requests = 0, selections = 0;
  Object.assign(f.stream, { getVideoTracks: () => [{ applyConstraints: async () => {
    selections++; throw Object.assign(new Error(), { name: 'OverconstrainedError' });
  } }] });
  const scanner = new LiveQrScanner(f.view, { getUserMedia: async () => { requests++; return f.stream; } }, () => 'valid');
  await scanner.start(() => true, () => assert.fail('Selection must not prevent scanning'));
  assert.equal(requests, 1); assert.equal(selections, 1); assert.equal(f.plays(), 1); assert.equal(f.stops(), 1);
});

test('closing during rear-camera selection releases the stream and prevents late playback', async () => {
  const f = fixture(); let finish!: () => void;
  const selection = new Promise<void>(resolve => { finish = resolve; });
  let entered!: () => void; const selecting = new Promise<void>(resolve => { entered = resolve; });
  Object.assign(f.stream, { getVideoTracks: () => [{ applyConstraints: () => { entered(); return selection; } }] });
  const scanner = new LiveQrScanner(f.view, { getUserMedia: async () => f.stream }, () => 'valid');
  const starting = scanner.start(() => assert.fail('Closed scanner'), () => assert.fail('No late issue'));
  await selecting; scanner.stop(); finish(); await starting;
  assert.equal(f.stops(), 1); assert.equal(f.plays(), 0); assert.equal(f.view.srcObject, null);
});
