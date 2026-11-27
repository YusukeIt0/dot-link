// Read the selected installation without changing it or importing its helpers.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tailscale } from './lib/setup.mjs';

function transportResult(error) {
  return error?.name === 'TimeoutError' || ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error?.cause?.code)
    ? 'unreachable' : 'unknown';
}

export async function checkSetupHealth(directory, {read = readFile, request = fetch, network = tailscale} = {}) {
  const health = {
    bridge:false, device:false, tunnel:false, tunnelCatalogFailed:false, subscribed:false, previouslySubscribed:false,
    bridgeCheck:'unknown', deviceCheck:'unknown', tunnelCheck:'unknown', subscriptionCheck:'unknown',
  };
  let key;
  try { key = (await read(join(directory, '.runtime/device-key'), 'utf8')).trim(); } catch {}
  if (key) {
    const headers = {Authorization:'Bearer ' + key};
    try {
      const response = await request('http://127.0.0.1:3460/api/status', {headers, redirect:'error', signal:AbortSignal.timeout(2000)});
      health.bridgeCheck = response.ok ? 'unknown' : 'failed';
      if (response.ok) {
        const status = await response.json();
        if (typeof status?.subscribed === 'boolean') {
          health.bridge = true;
          health.bridgeCheck = 'responded';
          health.subscribed = status.subscribed;
          health.subscriptionCheck = status.subscribed ? 'active' : 'inactive';
          health.previouslySubscribed = status.previouslySubscribed === true;
        }
      }
    } catch (error) { health.bridgeCheck = transportResult(error); }
    let route;
    try {
      route = await network();
    } catch { /* No route was available to check. */ }
    if (route?.state === 'ready') {
      try {
        const response = await request(route.origin + '/api/status', {headers, redirect:'error', signal:AbortSignal.timeout(3000)});
        health.device = response.ok;
        health.deviceCheck = response.ok ? 'responded' : 'failed';
      } catch (error) { health.deviceCheck = transportResult(error); }
    }
  }
  try {
    const response = await request('http://127.0.0.1:3461/readyz', {redirect:'error', signal:AbortSignal.timeout(2000)});
    health.tunnel = response.ok;
    health.tunnelCheck = response.ok ? 'responded' : 'failed';
    health.tunnelCatalogFailed = response.status === 503 && (await response.text()).trim() === 'startup catalog failed';
  } catch (error) { health.tunnelCheck = transportResult(error); }
  return health;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkSetupHealth(process.argv[2])));
}
