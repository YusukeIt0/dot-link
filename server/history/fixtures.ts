import { LocationHistoryReplay } from './replay.ts';
import { geographicEvidence } from '../geography/geometry.ts';
import type { GeographicDataset } from '../geography/types.ts';

// Deliberately synthetic names and geometry. No map query or personal trace.
export const historyGeography: GeographicDataset = {
  source: 'Synthetic test geometry', release: 'fixture-v1', attribution: 'Dot Link synthetic fixtures', license_url: 'https://opensource.org/license/mit',
  limitations: ['Invented fixture geometry; not a real place or a connected routing graph.'],
  features: [
    { id: 'area-a', kind: 'park', category: 'area', name: 'Fixture Garden', geometry: { type: 'Polygon', coordinates: [[[10, 10], [10.001, 10], [10.001, 10.001], [10, 10.001], [10, 10]]] } },
    { id: 'road-a', kind: 'road/residential', category: 'line', name: 'Fixture East Road', geometry: { type: 'LineString', coordinates: [[10.0005, 10.0005], [10.004, 10.0005]] } },
    { id: 'road-b', kind: 'road/residential', category: 'line', name: 'Fixture North Road', geometry: { type: 'LineString', coordinates: [[10.004, 10.0005], [10.004, 10.004]] } },
    { id: 'road-parallel', kind: 'road/service', category: 'line', name: 'Fixture Parallel Road', geometry: { type: 'LineString', coordinates: [[10.0042, 10.0005], [10.0042, 10.004]] } },
  ],
};

export const historyScenarios = ['walk', 'partial', 'stopped', 'empty', 'revoked', 'no-map'] as const;
export type HistoryScenario = typeof historyScenarios[number];

/** Deterministic two-day replay relative to the test reference, including a turn and revisit. */
export function historyFixture(scenario: HistoryScenario, reference: number) {
  let clock = reference - 26 * 3_600_000;
  const history = new LocationHistoryReplay({ now: () => clock,
    ...(scenario === 'no-map' ? {} : { geography: (fix) => geographicEvidence(fix, historyGeography) }) });
  history.setReadable(true);
  history.setRecording(true);
  let sequence = 0;
  const emit = (at: number, latitude: number, longitude: number, accuracy = 8) => {
    clock = at;
    return history.observe({ id: `fixture-${++sequence}`, source: 'synthetic_fixture', measured_at: new Date(at).toISOString(),
      latitude, longitude, accuracy, timezone: 'Etc/UTC', utc_offset_minutes: 0 });
  };
  const stay = (at: number, latitude: number, longitude: number) => {
    for (let i = 0; i <= 10; i++) emit(at + i * 60_000, latitude + (i % 2) * 0.00001, longitude);
  };
  if (scenario !== 'empty') {
    stay(reference - 26 * 3_600_000, 10.0005, 10.0005);
    const start = reference - 2 * 3_600_000;
    stay(start, 10.0005, 10.0005);
    // Moving points, including a 90-degree turn, with no implied connector across missing time.
    for (let i = 1; i <= 7; i++) {
      if (scenario === 'partial' && i >= 3 && i <= 6) continue;
      emit(start + (10 + i) * 60_000, 10.0005, 10.0005 + i * 0.0005);
    }
    if (scenario === 'stopped') history.setRecording(false);
    for (let i = 1; i <= 7; i++) emit(start + (17 + i) * 60_000, 10.0005 + i * 0.0005, 10.004, scenario === 'partial' ? 120 : 8);
    if (scenario === 'stopped') history.setRecording(true);
    stay(start + 40 * 60_000, 10.004, 10.004);
    // Return after an unobserved interval. Do not manufacture the return path.
    stay(start + 80 * 60_000, 10.0005, 10.0005);
  }
  clock = reference;
  history.setRecording(false);
  if (scenario === 'revoked') history.setReadable(false);
  return { history, advance: (ms: number) => { if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid time advance'); clock += ms; } };
}
