import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { microsoftEndpoint } from './stt-http.ts';
import { STTError, type STTProvider } from './stt.ts';
import { readSTTProvider, type CloudSTTProvider } from '../src/stt-providers.ts';

// This file contains the choice only. Credentials stay in the macOS Keychain.
export async function sttSelection(runtime: string): Promise<STTProvider> {
  let raw: string;
  try { raw = await readFile(join(runtime, 'stt.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'whisper'; throw new STTError('STT_UNAVAILABLE'); }
  try {
    if (raw.length > 1024) throw new Error();
    const value = JSON.parse(raw);
    if (value.version !== 1 || !readSTTProvider(value.provider)) throw new Error();
    return value.provider;
  } catch { throw new STTError('STT_UNAVAILABLE'); }
}

export async function saveSTTSelection(runtime: string, provider: unknown): Promise<void> {
  if (!readSTTProvider(provider)) throw new STTError('STT_UNAVAILABLE');
  await mkdir(runtime, {recursive: true, mode: 0o700});
  const temp = join(runtime, `.stt-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify({version: 1, provider}), {mode: 0o600, flag: 'wx'});
    await rename(temp, join(runtime, 'stt.json'));
  } finally { await rm(temp, {force: true}); }
}

// One bounded child process per explicit recognition request; no shell, argv key,
// startup reads, prompt retries, stderr forwarding, or persistent key cache.
export function keychainSTTKey(executable: string | undefined, provider: CloudSTTProvider = 'soniox'): () => Promise<string | undefined> {
  return () => new Promise((resolve, reject) => {
    if (!executable) { reject(new STTError('STT_KEY_REQUIRED')); return; }
    execFile(executable, ['--stt-credential', 'read', provider], {timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 8192}, (error, stdout) => {
      if (error) { reject(new STTError('STT_KEY_REQUIRED')); return; }
      try {
        const value = JSON.parse(stdout);
        if (value.status !== 'ok' || typeof value.key !== 'string' || value.key.length > 4096) throw new Error();
        resolve(value.key);
      } catch { reject(new STTError('STT_KEY_REQUIRED')); }
    });
  });
}

export async function sttMicrosoftEndpoint(runtime: string): Promise<string> {
  try {
    const raw = await readFile(join(runtime, 'stt-endpoints.json'), 'utf8');
    if (raw.length > 1024) throw new Error();
    const value = JSON.parse(raw);
    return microsoftEndpoint(value.microsoft);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new STTError('STT_CONFIG_REQUIRED');
  }
}
export async function saveSTTMicrosoftEndpoint(runtime: string, endpoint: unknown): Promise<void> {
  const microsoft = microsoftEndpoint(endpoint);
  await mkdir(runtime, {recursive:true, mode:0o700});
  const temp = join(runtime, `.stt-endpoints-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify({version:1, microsoft}), {mode:0o600, flag:'wx'});
    await rename(temp, join(runtime, 'stt-endpoints.json'));
  } finally { await rm(temp, {force:true}); }
}
