import { validateWav } from './asr.ts';

import { STT_PROVIDERS, readSTTProvider, type STTProvider } from '../src/stt-providers.ts';
export type { STTProvider } from '../src/stt-providers.ts';
export type STTErrorCode = 'STT_BUSY' | 'STT_KEY_REQUIRED' | 'STT_AUTH' | 'STT_QUOTA' |
  'STT_CONFIG_REQUIRED' | 'STT_UNAVAILABLE' | 'STT_TIMEOUT' | 'STT_CANCELLED' | 'STT_INVALID_RESPONSE' | 'STT_NO_TEXT';

// Only these messages may leave the adapter. Never expose provider bodies, keys or audio.
export class STTError extends Error {
  readonly code: STTErrorCode;
  constructor(code: STTErrorCode) { super(code); this.name = 'STTError'; this.code = code; }
}

export type Transcriber = (wav: Buffer, signal?: AbortSignal) => Promise<string>;
export function selectableTranscriber(options: {
  selection: () => Promise<STTProvider>;
  whisper: Transcriber;
  soniox: Transcriber;
  providers?: Partial<Record<STTProvider, Transcriber>>;
}): Transcriber {
  let busy = false;
  return async (wav, signal) => {
    validateWav(wav);
    if (signal?.aborted) throw new STTError('STT_CANCELLED');
    if (busy) throw new STTError('STT_BUSY');
    busy = true;
    try {
      const provider = await options.selection();
      if (signal?.aborted) throw new STTError('STT_CANCELLED');
      // Explicit selection only: an error must not silently send audio elsewhere.
      if (provider === 'whisper') return await options.whisper(wav, signal);
      if (provider === 'soniox') return await options.soniox(wav, signal);
      const additional = readSTTProvider(provider) && options.providers?.[provider];
      if (additional) return await additional(wav, signal);
      throw new STTError('STT_UNAVAILABLE');
    } finally { busy = false; }
  };
}

export interface STTSocket {
  readyState: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export function sonioxTranscriber(options: {
  key: () => Promise<string | undefined>;
  connect?: (url: string, protocols: string[]) => STTSocket;
  timeoutMs?: number;
}): Transcriber {
  return async (wav, signal) => {
    validateWav(wav);
    if (signal?.aborted) throw new STTError('STT_CANCELLED');
    let key: string | undefined;
    try { key = await options.key(); } catch { throw new STTError('STT_KEY_REQUIRED'); }
    if (!key) throw new STTError('STT_KEY_REQUIRED');
    // WebSocket protocol values must be HTTP tokens; never interpolate a key into a URL.
    if (key.length > 4096 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new STTError('STT_AUTH');
    if (signal?.aborted) throw new STTError('STT_CANCELLED');
    let socket: STTSocket;
    try {
      socket = (options.connect ?? ((url, protocols) => new WebSocket(url, protocols)))(
        'wss://stt-rt.soniox.com/transcribe-websocket', ['soniox-api-key', key]);
    } catch { throw new STTError('STT_UNAVAILABLE'); }
    key = undefined;
    return await new Promise<string>((resolve, reject) => {
      let done = false, text = '', receivedBytes = 0;
      const settle = (error?: STTError, result?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        for (const [type, handler] of handlers) socket.removeEventListener(type, handler);
        // Closing a still-connecting native socket can emit a late error event.
        socket.addEventListener('error', () => {});
        try { socket.close(); } catch {}
        text = '';
        error ? reject(error) : resolve(result!);
      };
      const fail = (code: STTErrorCode) => settle(new STTError(code));
      const abort = () => fail('STT_CANCELLED');
      const open = () => {
        if (done) return;
        try {
          socket.send(JSON.stringify({ model: STT_PROVIDERS.soniox.model, audio_format: 'auto' }));
          for (let offset = 0; offset < wav.length; offset += 32000) socket.send(new Uint8Array(wav.subarray(offset, offset + 32000)));
          socket.send('');
        } catch { fail('STT_UNAVAILABLE'); }
      };
      const message = (event: {data: unknown}) => {
        if (done) return;
        try {
          if (typeof event.data !== 'string') return fail('STT_INVALID_RESPONSE');
          receivedBytes += Buffer.byteLength(event.data);
          if (receivedBytes > 1024 * 1024) return fail('STT_INVALID_RESPONSE');
          const body = JSON.parse(event.data);
          if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('STT_INVALID_RESPONSE');
          if (body.error_code || body.error_type) {
            if (['unauthenticated', 'permission_denied'].includes(body.error_type) || [401, 403].includes(body.error_code)) return fail('STT_AUTH');
            if (['organization_balance_exhausted', 'organization_monthly_budget_exhausted', 'limit_exceeded', 'max_concurrent_connections_reached'].includes(body.error_type) || [402, 429].includes(body.error_code)) return fail('STT_QUOTA');
            return fail('STT_UNAVAILABLE');
          }
          if (!Array.isArray(body.tokens)) return fail('STT_INVALID_RESPONSE');
          for (const token of body.tokens) {
            if (!token || typeof token.text !== 'string' || typeof token.is_final !== 'boolean') return fail('STT_INVALID_RESPONSE');
            if (token.is_final && !['<end>', '<fin>'].includes(token.text)) text += token.text;
            if (text.length > 4000) return fail('STT_INVALID_RESPONSE');
          }
          if (body.finished === true) {
            const result = text.trim();
            result ? settle(undefined, result) : fail('STT_NO_TEXT');
          }
        } catch { fail('STT_INVALID_RESPONSE'); }
      };
      const handlers: Array<[string, (event: any) => void]> = [
        ['open', open], ['message', message], ['error', () => fail('STT_UNAVAILABLE')],
        ['close', () => fail('STT_UNAVAILABLE')],
      ];
      const timer = setTimeout(() => fail('STT_TIMEOUT'), options.timeoutMs ?? 85000);
      for (const [type, handler] of handlers) socket.addEventListener(type, handler);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
}
