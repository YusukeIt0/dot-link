/** A phone measurement, never an inferred visit or the glasses' field of view. */
export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  measured_at: string;
  speed?: number;
  heading?: number;
}

export const LOCATION_FRESH_MS = 90_000;
export const LOCATION_MAX_ACCURACY_M = 200;
export const LOCATION_LEASE_MS = 90_000;

export function distanceMeters(a: Pick<LocationFix, 'latitude' | 'longitude'>, b: Pick<LocationFix, 'latitude' | 'longitude'>): number {
  const radians = Math.PI / 180;
  const lat = (b.latitude - a.latitude) * radians;
  const lon = (b.longitude - a.longitude) * radians;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(lon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function freshLocation(fix: LocationFix | undefined, now: number): fix is LocationFix {
  if (!fix) return false;
  const age = now - Date.parse(fix.measured_at);
  return Number.isFinite(age) && age >= -10_000 && age <= LOCATION_FRESH_MS && fix.accuracy <= LOCATION_MAX_ACCURACY_M;
}

/** Require a real measurement time and accuracy; do not label cached/unknown fixes current. */
export function phoneLocation(raw: unknown, now: number): LocationFix | undefined {
  if (!raw || typeof raw !== 'object') return;
  const p = raw as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (!finite(p.latitude) || Math.abs(p.latitude) > 90 || !finite(p.longitude) || Math.abs(p.longitude) > 180 ||
      !finite(p.accuracy) || p.accuracy < 0 || !finite(p.timestamp) || Math.abs(p.timestamp) > 8.64e15) return;
  const fix: LocationFix = { latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, measured_at: new Date(p.timestamp).toISOString() };
  if (finite(p.speed) && p.speed >= 0 && p.speed <= 400) fix.speed = p.speed;
  if (finite(p.heading) && p.heading >= 0 && p.heading < 360) fix.heading = p.heading;
  return freshLocation(fix, now) ? fix : undefined;
}
