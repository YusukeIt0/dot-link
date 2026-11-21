import test from 'node:test';
import assert from 'node:assert/strict';
import { healthStatusKey } from '../src/health-sharing.ts';

test('temporary Polar failures say Dot Link retries; only owner-actionable failures point to Mac settings (#431)', () => {
  const base = {supported: true, pending: false, failed: false, refreshed: false, healthConfigured: true, healthEnabled: true};
  for (const code of ['HEALTH_REQUEST_FAILED', 'HEALTH_INVALID_RESPONSE', 'HEALTH_NETWORK_UNAVAILABLE', 'HEALTH_RATE_LIMITED'])
    assert.equal(healthStatusKey({...base, healthStatus: code}), 'even.health_retrying', code);
  for (const code of ['HEALTH_RECONNECT_REQUIRED', 'HEALTH_CREDENTIALS_REQUIRED', 'HEALTH_STORAGE_UNAVAILABLE', 'disconnect_pending'])
    assert.equal(healthStatusKey({...base, healthStatus: code}), 'even.health_error', code);
  assert.equal(healthStatusKey({...base, healthStatus: 'locked'}), 'even.health_locked');
  assert.equal(healthStatusKey({...base, healthStatus: 'sharing'}), 'even.health_on');
  assert.equal(healthStatusKey({...base, healthConfigured: false}), 'even.health_setup');
});
