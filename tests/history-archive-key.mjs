// Run on an Apple Silicon Mac with two signed builds of the app executable.
// All keys stay in these disposable processes. Assertions report no key material.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const [first, updated] = process.argv.slice(2);
assert(first && updated, 'Expected the paths of both Mac executables');

function request(binary, operation, input, success = true) {
  const call = spawnSync(binary, ['--history-archive-key', operation], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024
  });
  assert(!call.error && call.signal === null, 'Helper failed to finish');
  assert(call.stderr.length === 0, 'Helper emitted diagnostics');
  const result = JSON.parse(call.stdout);
  if (!success) {
    assert(call.status !== 0 && Object.keys(result).join() === 'error' &&
      result.error === 'HISTORY_ARCHIVE_KEY_UNAVAILABLE', 'Expected a closed failure');
  } else {
    assert(call.status === 0, 'Helper did not complete the operation');
    assert(typeof result.key === 'string' && Buffer.from(result.key, 'base64').length === 32, 'Expected a 256-bit key');
  }
  return result;
}

const original = request(first, 'create', {});
const another = request(updated, 'create', {});
assert(original.key !== another.key, 'Generations must have different data keys');
for (const executable of [first, updated]) {
  const result = request(executable, 'open', { wrapped: original.wrapped });
  assert(Object.keys(result).join() === 'key' && result.key === original.key, 'Could not reopen the same key');
}
request(updated, 'open', { wrapped: another.wrapped });
request(updated, 'open', { wrapped: original.wrapped, extra: 'unexpected' }, false);
request(updated, 'create', { wrapped: original.wrapped }, false);
request(updated, 'open', { wrapped: 'a'.repeat(17000) }, false);
request(updated, 'open', { wrapped: 'invalid-envelope' }, false);
const envelope = JSON.parse(Buffer.from(original.wrapped, 'base64').toString('utf8'));
const otherEnvelope = JSON.parse(Buffer.from(another.wrapped, 'base64').toString('utf8'));
const tampered = Buffer.from(envelope.sealedKey, 'base64');
tampered[tampered.length - 1] ^= 1;
for (const change of [
  { version: 2 }, { sealedKey: tampered.toString('base64') }, { deviceKey: otherEnvelope.deviceKey },
  { ephemeralPublicKey: otherEnvelope.ephemeralPublicKey }
]) {
  const wrapped = Buffer.from(JSON.stringify({ ...envelope, ...change })).toString('base64');
  request(updated, 'open', { wrapped }, false);
}
console.log('History archive keys reopened across builds; malformed inputs and mixed or tampered envelopes were rejected.');
