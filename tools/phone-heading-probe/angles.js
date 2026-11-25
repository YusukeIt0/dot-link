export const sources = ['webkitCompass', 'flatAbsoluteAlpha', 'evenLocation'];
const rounded = n => Math.round(n * 10) / 10;
export const delta = (to, from) => rounded(((to - from + 540) % 360) - 180);
const validHeading = n => Number.isFinite(n) && n >= 0 && n <= 360;

export function phoneAngles(event) {
  const fields = {};
  const accuracy = event.webkitCompassAccuracy;
  if (validHeading(event.webkitCompassHeading) && !(Number.isFinite(accuracy) && accuracy < 0)) {
    fields.webkitCompass = { deg: event.webkitCompassHeading % 360,
      accuracy: Number.isFinite(accuracy) ? accuracy : null };
  }
  // For a face-up device, W3C alpha increases counterclockwise from north.
  // An arbitrary relative alpha must never be treated as an Earth reference.
  if ((event.absolute === true || event.type === 'deviceorientationabsolute') && validHeading(event.alpha)
      && Number.isFinite(event.beta) && Math.abs(event.beta) <= 20
      && Number.isFinite(event.gamma) && Math.abs(event.gamma) <= 20) {
    fields.flatAbsoluteAlpha = { deg: (360 - event.alpha) % 360, accuracy: null };
  }
  return fields;
}

export function readFix(fix, receivedAt) {
  if (!fix) return { state: 'no fix', sample: null, ageMs: null, stamp: null };
  // The bridge fixes contain coordinates. Never access or retain them here.
  const raw = fix.timestamp;
  const stamp = !Number.isFinite(raw) ? null : raw >= 1e12 ? raw : raw >= 1e9 && raw < 1e11 ? raw * 1000 : null;
  const sample = validHeading(fix.heading) ? { deg: fix.heading % 360, accuracy: null } : null;
  return { state: sample ? 'fix with heading' : 'fix without heading', sample, stamp,
    ageMs: stamp === null ? null : Math.round(receivedAt - stamp) };
}

export function summary(samples) {
  if (!samples.length) return { center: null, count: 0, spread: null, accuracy: null };
  let x = 0, y = 0;
  for (const s of samples) {
    const radians = s.deg * Math.PI / 180;
    x += Math.cos(radians);
    y += Math.sin(radians);
  }
  if (Math.hypot(x, y) < 1e-6 * samples.length) {
    return { center: null, count: samples.length, spread: null, accuracy: null };
  }
  const center = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const accuracies = samples.map(s => s.accuracy).filter(Number.isFinite);
  return { center, count: samples.length,
    spread: rounded(Math.max(...samples.map(s => Math.abs(delta(s.deg, center))))),
    accuracy: accuracies.length ? rounded(Math.max(...accuracies)) : null };
}

export function exportPoses(poses) {
  const results = {};
  for (const source of sources) {
    const held = poses.map(p => p.sources[source]);
    const base = held[0]?.center;
    const changes = held.map(h => base != null && h.center != null ? delta(h.center, base) : null);
    let outcome = 'incomplete';
    if (changes.length === 3 && changes.every(Number.isFinite)) {
      if (held.some(h => h.spread > 25)) outcome = 'unstable during hold';
      else if (source === 'evenLocation' && poses.some(p => p.fix.reused || (p.fix.ageMs != null && (p.fix.ageMs < -2000 || p.fix.ageMs > 15000)))) outcome = 'cached or stale fix';
      else if (changes[1] >= 55 && changes[1] <= 125 && Math.abs(changes[2]) <= 25) outcome = 'tracks right turn and return';
      else if (changes.every(a => Math.abs(a) <= 15)) outcome = 'little change';
      else outcome = 'different from marked turn';
    }
    results[source] = { changes, outcome,
      holds: held.map(h => ({ count: h.count, spread: h.spread, accuracy: h.accuracy })) };
  }
  return results;
}
