import { execFile } from 'node:child_process';

export interface ArchiveKeyProvider {
  create(): Promise<{key: Buffer; wrapped: string}>;
  open(wrapped: string): Promise<Buffer>;
}

const unavailable = () => new Error('HISTORY_ARCHIVE_KEY_UNAVAILABLE');
const validWrapped = (value: unknown): value is string => typeof value === 'string' &&
  value.length >= 64 && value.length <= 12_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

/** Private pipe to the packaged Mac helper. Neither the key nor its envelope is an argument. */
export function archiveKeyProvider(executable?: string): ArchiveKeyProvider {
  function call(operation: 'create' | 'open', input: {wrapped?: string}) {
    return new Promise<{key: Buffer; wrapped: string}>((resolve, reject) => {
      if (!executable) { reject(unavailable()); return; }
      const child = execFile(executable, ['--history-archive-key', operation],
        {timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 16_384}, (error, stdout) => {
          if (error) { reject(unavailable()); return; }
          try {
            const result = JSON.parse(stdout);
            const wrapped = input.wrapped ?? result.wrapped;
            if (!validWrapped(wrapped) || typeof result.key !== 'string' ||
                !/^[A-Za-z0-9+/]{43}=$/.test(result.key)) throw unavailable();
            resolve({key: Buffer.from(result.key, 'base64'), wrapped});
          } catch { reject(unavailable()); }
        });
      child.stdin?.on('error', () => reject(unavailable()));
      child.stdin?.end(JSON.stringify(input));
    });
  }
  return {
    create: () => call('create', {}),
    open: async wrapped => {
      if (!validWrapped(wrapped)) throw unavailable();
      return (await call('open', {wrapped})).key;
    },
  };
}
