import { distanceMeters } from '../../src/location-fix.ts';
import type { GeographicDataset, GeographicEvidence, GeographicFeature, GeographicFix, GeographicReference, Geometry, Position } from './types.ts';

const RAD = Math.PI / 180;
const wrap = (lon: number) => ((lon + 180) % 360 + 360) % 360 - 180;
const pointFix = (p: Position) => ({ longitude: p[0], latitude: p[1] });

/** Validate downloaded geometry before spatial work. Bound nesting and vertices. */
export function validGeometry(raw: unknown, maximumVertices = 50_000): raw is Geometry {
  if (!raw || typeof raw !== 'object') return false;
  const { type, coordinates } = raw as {type?: string; coordinates?: unknown};
  let count = 0;
  const position = (p: unknown): p is Position => Array.isArray(p) && p.length === 2 &&
    p.every(v => typeof v === 'number' && Number.isFinite(v)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 && ++count <= maximumVertices;
  const line = (p: unknown): p is Position[] => Array.isArray(p) && p.length >= 2 && p.length <= maximumVertices && p.every(position);
  const ring = (p: unknown) => line(p) && p.length >= 4 && p[0][0] === p.at(-1)![0] && p[0][1] === p.at(-1)![1];
  const polygon = (p: unknown) => Array.isArray(p) && p.length > 0 && p.length <= maximumVertices && p.every(ring);
  switch (type) {
    case 'Point': return position(coordinates);
    case 'MultiPoint': return Array.isArray(coordinates) && coordinates.length > 0 && coordinates.length <= maximumVertices && coordinates.every(position);
    case 'LineString': return line(coordinates);
    case 'MultiLineString': return Array.isArray(coordinates) && coordinates.length > 0 && coordinates.length <= maximumVertices && coordinates.every(line);
    case 'Polygon': return polygon(coordinates);
    case 'MultiPolygon': return Array.isArray(coordinates) && coordinates.length > 0 && coordinates.length <= maximumVertices && coordinates.every(polygon);
    default: return false;
  }
}

function bearing(fix: GeographicFix, p: Position) {
  const a = fix.latitude * RAD, b = p[1] * RAD, d = wrap(p[0] - fix.longitude) * RAD;
  return (Math.atan2(Math.sin(d) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(d)) / RAD + 360) % 360;
}

/** Short-range distance to a segment using a local tangent-plane projection. */
function segmentNearest(fix: GeographicFix, a: Position, b: Position): Position {
  const scale = Math.max(1e-6, Math.cos(fix.latitude * RAD));
  const ax = wrap(a[0] - fix.longitude), bx = ax + wrap(b[0] - a[0]);
  const x = ax * scale, y = a[1] - fix.latitude;
  const dx = (bx - ax) * scale, dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / (dx * dx + dy * dy || 1)));
  return [wrap(a[0] + (bx - ax) * t), a[1] + dy * t];
}

function ringContains(fix: GeographicFix, ring: Position[]) {
  // Unwrap the ring continuously, then move the query into that longitude copy.
  // This handles a small polygon crossing the antimeridian without filling the
  // rest of the world. Holes use the same independent-ring rule.
  const points: Position[] = [ring[0]];
  for (let i = 1; i < ring.length; i++) points.push([points[i - 1][0] + wrap(ring[i][0] - ring[i - 1][0]), ring[i][1]]);
  const x = ring[0][0] + wrap(fix.longitude - ring[0][0]), y = fix.latitude;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonContains(fix: GeographicFix, rings: Position[][]) {
  return ringContains(fix, rings[0]) && !rings.slice(1).some(ring => ringContains(fix, ring));
}

export function spatialRelation(fix: GeographicFix, geometry: Geometry): { inside: boolean; distance: number; nearest: Position } {
  let nearest: Position = [0, 0], distance = Infinity, inside = false;
  const point = (p: Position) => { const d = distanceMeters(fix, pointFix(p)); if (d < distance) {distance = d; nearest = p;} };
  const line = (positions: Position[]) => {
    for (let i = 1; i < positions.length; i++) point(segmentNearest(fix, positions[i - 1], positions[i]));
  };
  switch (geometry.type) {
    case 'Point': point(geometry.coordinates); break;
    case 'MultiPoint': geometry.coordinates.forEach(point); break;
    case 'LineString': line(geometry.coordinates); break;
    case 'MultiLineString': geometry.coordinates.forEach(line); break;
    case 'Polygon': inside = polygonContains(fix, geometry.coordinates); geometry.coordinates.forEach(line); break;
    case 'MultiPolygon':
      inside = geometry.coordinates.some(p => polygonContains(fix, p));
      geometry.coordinates.forEach(p => p.forEach(line)); break;
  }
  return { inside, distance, nearest };
}

/** Approximate mapped reference only; it does not snap a fix onto a road or path. */
export function geographicEvidence(fix: GeographicFix, dataset: GeographicDataset): GeographicEvidence {
  if (!Number.isFinite(fix.latitude) || Math.abs(fix.latitude) > 85 || !Number.isFinite(fix.longitude) || Math.abs(fix.longitude) > 180 ||
      !Number.isFinite(fix.accuracy) || fix.accuracy < 0 || fix.accuracy > 200) throw new Error('Unsupported geographic measurement');
  const groups: Record<GeographicFeature['category'], GeographicReference[]> = { area: [], line: [], landmark: [] };
  const seen = new Set<string>();
  for (const feature of dataset.features) {
    if (seen.has(feature.id)) continue;
    seen.add(feature.id);
    const { inside, distance, nearest } = spatialRelation(fix, feature.geometry);
    const limit = feature.category === 'landmark' ? 5_000 : feature.category === 'line' ? 1_000 : 1_500;
    if (!inside && distance > limit) continue;
    const polygon = feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon';
    const relation = polygon && distance <= fix.accuracy + 2 ? 'boundary_uncertain' : inside ? 'within_mapped_area' : 'near';
    const reference: GeographicReference = { id: feature.id, kind: feature.kind,
      ...(feature.name ? { name: feature.name } : {}), ...(feature.names ? { names: feature.names } : {}),
      relation, distance_m: inside && relation === 'within_mapped_area' ? 0 : Math.round(distance),
      ...(!inside && distance > fix.accuracy ? { bearing_degrees: Math.round(bearing(fix, nearest)) % 360 } : {}) };
    groups[feature.category].push(reference);
  }
  const rank = (a: GeographicReference, b: GeographicReference) =>
    Number(b.relation === 'within_mapped_area') - Number(a.relation === 'within_mapped_area') || a.distance_m - b.distance_m || Number(!!b.name) - Number(!!a.name) || a.id.localeCompare(b.id);
  const lines = groups.line.sort(rank);
  const uniqueLines = lines.filter((line, i) => !line.name || lines.findIndex(other => other.name === line.name && other.kind === line.kind) === i);
  // Preserve nearby unnamed paths while leaving room for named street references.
  const selectedLines = uniqueLines.slice(0, 3);
  for (const line of [...uniqueLines.filter(line => line.name), ...uniqueLines]) {
    if (selectedLines.length >= 6) break;
    if (!selectedLines.includes(line)) selectedLines.push(line);
  }
  return { source: dataset.source, release: dataset.release, attribution: dataset.attribution, license_url: dataset.license_url,
    areas: groups.area.sort(rank).slice(0, 6), lines: selectedLines.sort(rank), landmarks: groups.landmark.sort(rank).slice(0, 6),
    limitations: [...dataset.limitations, 'Map reference data may be incomplete or outdated; proximity does not establish presence on a road or trail.'] };
}
