// Relative to the initial level direction. Geographic north is optional.
export const poses = [
  ['F1', 'Look straight ahead', '最初の正面を向く'],
  ['R1', 'Turn right a quarter turn', '右に90度回る'],
  ['B1', 'Turn right again to face the back', 'もう一度右に90度。後ろを向く'],
  ['L1', 'Turn right another quarter turn', 'また右に90度回る'],
  ['F2', 'Turn right to face the start', '右に90度。最初の正面に戻る'],
  ['L2', 'Turn left a quarter turn', '今度は左に90度回る'],
  ['B2', 'Turn left again to face the back', 'もう一度左に90度。後ろを向く'],
  ['R2', 'Turn left another quarter turn', 'また左に90度回る'],
  ['F3', 'Turn left to face the start', '左に90度。最初の正面に戻る'],
  ['pitch', 'Face forward and look slightly up', '正面のまま、少し上を向く'],
  ['roll', 'Face level, then tilt your right ear toward your shoulder', '正面に戻し、右耳を右肩に少し近づける'],
  ['F4', 'Return to level facing the start', '顔を水平にして、最初の正面を向く'],
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
