// Poses refer to the glasses. Keep the phone still throughout.
export const poses = [
  ['N1', 'Face north, level'], ['E1', 'Face east, level'],
  ['S1', 'Face south, level'], ['W1', 'Face west, level'],
  ['N2', 'Face north again, level'], ['W2', 'Face west, level'],
  ['S2', 'Face south, level'], ['E2', 'Face east, level'],
  ['N3', 'Return to north, level'], ['pitch', 'Face north, look up about 25°'],
  ['roll', 'Face north, tilt right ear down about 25°'],
  ['N4', 'Return to north, level'],
];

export const limits = { sessionMs: 240000, settleMs: 900, holdMs: 2200, samples: 3000 };
const round = value => Math.round(value * 1000) / 1000;

export function summarize(rows) {
  return poses.flatMap(([pose]) => {
    const group = rows.filter(row => row.pose === pose && row.phase === 'hold');
    if (!group.length) return [];
    const vectors = group.filter(row => [row.x, row.y, row.z].every(Number.isFinite));
    const means = {};
    const ranges = {};
    for (const axis of ['x', 'y', 'z', 'magnitude']) {
      const values = vectors.map(row => axis === 'magnitude' ? Math.hypot(row.x, row.y, row.z) : row[axis]);
      means[axis] = values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
      ranges[axis] = values.length ? [round(Math.min(...values)), round(Math.max(...values))] : null;
    }
    return [{ pose, received: group.length, complete: vectors.length, means, ranges }];
  });
}

export function numericAxis(value) {
  return Number.isFinite(value) ? value : null;
}

// The SDK's typed IMU object drops extra fields. Inspect only explicitly named
// motion fields in its original host payload; never export the entire event.
const scalars = new Set(['heading', 'headingdeg', 'headingdegrees', 'magneticheading', 'trueheading',
  'headingaccuracy', 'compassheading', 'compassindex', 'azimuth', 'yaw', 'pitch', 'roll']);
const vectors = new Set(['magnetometer', 'magneticfield', 'gyro', 'gyroscope', 'quaternion', 'rotationrate']);
const sensorObjects = new Set(['imudata', 'compassdata', 'orientation']);
const normalized = key => key.replaceAll('_', '').toLowerCase();

export function hostMotion(raw) {
  const fields = {};
  function read(object, prefix) {
    if (!object || typeof object !== 'object') return;
    for (const [key, value] of Object.entries(object)) {
      const name = normalized(key);
      if (scalars.has(name) && Number.isFinite(value)) fields[prefix + name] = value;
      if (!vectors.has(name) || !value || typeof value !== 'object') continue;
      for (const axis of ['x', 'y', 'z', 'w', 'alpha', 'beta', 'gamma']) {
        if (Number.isFinite(value[axis])) fields[prefix + name + '.' + axis] = value[axis];
      }
    }
  }
  read(raw, '');
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const name = normalized(key);
      if (sensorObjects.has(name)) read(value, name + '.');
    }
  }
  return fields;
}
