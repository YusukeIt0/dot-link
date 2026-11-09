// Explicit manual probe using public fixtures only. Never import a phone location.
import { resolve } from 'node:path';
import { WeatherService } from '../server/weather/service.ts';

const fixtures = {
  tokyo: {latitude: 35.68, longitude: 139.76},
  bangkok: {latitude: 13.73, longitude: 100.54},
  oslo: {latitude: 59.91, longitude: 10.75},
  nairobi: {latitude: -1.29, longitude: 36.82},
  amazon: {latitude: -3.12, longitude: -60.02},
  sydney: {latitude: -33.87, longitude: 151.21},
  yosemite: {latitude: 37.75, longitude: -119.59},
  everest: {latitude: 27.99, longitude: 86.93},
  antarctic: {latitude: -77.85, longitude: 166.67},
};
const [name, cachePath, acknowledgement] = process.argv.slice(2);
if (!Object.hasOwn(fixtures, name ?? '') || !cachePath || acknowledgement !== '--human-accepted-met-terms') {
  console.error('Usage: node scripts/measure-weather.mjs <public-fixture> <persistent-cache-file> --human-accepted-met-terms');
  console.error('Fixtures: ' + Object.keys(fixtures).join(', '));
  console.error('A human with authority must first read and accept https://api.met.no/doc/TermsOfService. The flag records that prerequisite; an agent must not invent acceptance. Reuse the same cache file across probes/restarts.');
  process.exitCode = 2;
} else {
  const service = new WeatherService(resolve(cachePath));
  const started = performance.now();
  try {
    const result = await service.query(fixtures[name], AbortSignal.timeout(25_000), () => {});
    console.log(JSON.stringify({fixture: name, elapsed_ms: Math.round(performance.now() - started), ...result}, null, 2));
    if (result.status === 'unavailable') process.exitCode = 1;
  } finally {service.close();}
}
