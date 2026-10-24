import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import catalog from './setup-errors.json' with { type: 'json' };

const known = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT', 'SIGSEGV']);

// Keep human CLI messages compatible while attaching a stable machine code.
export function setupError(code, message = catalog.codes[code]?.en, cause) {
  return Object.assign(new Error(message, { cause }), { setupCode: code });
}

// Never forward exception messages, command output, paths, hostnames or arbitrary
// uppercase strings. This is also the trust boundary for child JSON and disk/UI.
export function readSetupFailure(value) {
  if (!value || value.version !== 1 || !known(catalog.codes, value.code) || !known(catalog.stages, value.stage)) return undefined;
  const safe = { version: 1, code: value.code, stage: value.stage };
  if (Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255) safe.exitCode = value.exitCode;
  if (signals.has(value.signal)) safe.signal = value.signal;
  return safe;
}

export function setupFailure(error, stage = 'install', fallback = 'SETUP_FAILED') {
  const inherited = readSetupFailure(error?.failure);
  if (inherited) return inherited;
  const source = error?.cause ?? error;
  let code = known(catalog.codes, error?.setupCode) ? error.setupCode
    : known(catalog.codes, error?.message) ? error.message : fallback;
  // Only interpret output from the Serve setup stage. Retain the actionable
  // approval reason even when Serve waits until the command timeout kills it.
  // Never retain the approval URL (which can contain device identifiers).
  const serveApproval = stage === 'https' && fallback === 'TAILSCALE_HTTPS_FAILED'
    && [source?.stdout, source?.stderr].some(output => typeof output === 'string' && output.includes('login.tailscale.com/f/serve'));
  if (serveApproval) code = 'TAILSCALE_SERVE_APPROVAL_REQUIRED';
  else if (source?.killed === true && source?.signal === 'SIGTERM' && source?.code == null) code = 'SETUP_TIMEOUT';
  else if (['EACCES', 'EPERM'].includes(source?.code)) code = 'SETUP_PERMISSION_DENIED';
  else if (source?.code === 'ENOSPC') code = 'SETUP_DISK_FULL';
  else if (code === 'SETUP_FAILED' && (Number.isInteger(source?.code) || typeof source?.stdout === 'string' || source?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) code = 'SETUP_COMMAND_FAILED';
  return readSetupFailure({ version: 1, code, stage, exitCode: source?.code, signal: source?.signal })
    ?? { version: 1, code: 'SETUP_FAILED', stage: 'install' };
}

function failureError(failure) {
  return Object.assign(new Error(failure.code), { failure });
}

export async function setupStage(stage, operation, fallback = 'SETUP_FAILED') {
  try { return await operation(); }
  catch (error) { throw failureError(setupFailure(error, stage, fallback)); }
}

export function setupFailureMessage(failure, language = 'en') {
  const locale = Object.hasOwn(catalog.codes[failure.code], language) ? language : 'en';
  return `${catalog.stages[failure.stage][locale]}: ${catalog.codes[failure.code][locale]}`;
}

export async function runSetupInstall(execute) {
  let output;
  try { output = await execute(); }
  catch (error) {
    let child;
    try { child = JSON.parse(error.stdout); } catch {}
    const failure = child?.ready === false && readSetupFailure(child.failure);
    // A valid structured failure survives a nonzero child exit. Unstructured
    // legacy issues/stderr must not be displayed or copied verbatim.
    if (failure && error.killed !== true && !error.signal) throw failureError(failure);
    throw failureError(setupFailure(error, 'install'));
  }
  let response;
  try { response = JSON.parse(output); } catch { throw setupError('SETUP_INVALID_RESPONSE'); }
  if (response?.ready === false) {
    throw failureError(readSetupFailure(response.failure) ?? { version: 1, code: 'SETUP_INVALID_RESPONSE', stage: 'install' });
  }
  if (!Array.isArray(response?.changed) || !response.changed.every(name => ['bridge', 'device', 'tunnel', 'menu'].includes(name))) {
    throw setupError('SETUP_INVALID_RESPONSE');
  }
  return response;
}

// Operations remain sequential; a failed stage cannot start later mutations.
export async function activateRelay(operations) {
  for (const stage of ['install', 'app-install', 'app-register', 'runtime-prepare', 'runtime-finish']) {
    await setupStage(stage, operations[stage]);
  }
  return setupStage('health', operations.health);
}

export async function saveSetupFailure(directory, failure) {
  const safe = readSetupFailure(failure);
  if (!safe) return false;
  const path = join(directory, '.runtime/setup-failure.json');
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ ...safe, failedAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
    return true;
  } catch {
    await unlink(temp).catch(() => {});
    return false; // A diagnostic write must never replace the original failure.
  }
}

export async function clearSetupFailure(directory) {
  await unlink(join(directory, '.runtime/setup-failure.json')).catch(() => {});
}
