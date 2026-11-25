// Inspect only public SDK event payloads and named numeric motion fields.
const scalars = new Set(['heading', 'headingdeg', 'headingdegrees', 'trueheading', 'magneticheading',
  'compassheading', 'compassindex', 'azimuth', 'yaw']);
const containers = new Set(['imudata', 'orientation', 'compass', 'compassinfo', 'compassinfomsg', 'compassdata', 'sysevent']);
const normalized = key => key.replaceAll('_', '').toLowerCase();

export function bearingCandidates(payload) {
  const result = {};
  function visit(node, parts) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const key of Object.keys(node)) {
      const name = normalized(key);
      const path = [...parts, name];
      const compassAngle = name === 'degrees' && parts.some(p => p.startsWith('compass'));
      if (scalars.has(name) || compassAngle) {
        const value = node[key];
        const minimum = name === 'yaw' ? -360 : 0;
        if (Number.isFinite(value) && value >= minimum && value <= 360) result[path.join('.')] = value;
      } else if (parts.length < 3 && containers.has(name)) {
        visit(node[key], path);
      }
    }
  }
  visit(payload, []);
  return result;
}
