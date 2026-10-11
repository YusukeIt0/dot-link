import { validateWav } from './asr.ts';
import { STTError, type Transcriber } from './stt.ts';
import { STT_PROVIDERS } from '../src/stt-providers.ts';

export type HTTPSTTProvider = 'elevenlabs' | 'microsoft' | 'openai' | 'assemblyai';
// A resource endpoint, never an arbitrary proxy or a URL containing credentials.
export function microsoftEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) throw new STTError('STT_CONFIG_REQUIRED');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new STTError('STT_CONFIG_REQUIRED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== '/' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cognitiveservices\.azure\.com$/.test(url.hostname))
    throw new STTError('STT_CONFIG_REQUIRED');
  return url.origin;
}

async function boundedJSON(response: Response): Promise<any> {
  if (!response.body) throw new STTError('STT_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 1024 * 1024) { await reader.cancel(); throw new STTError('STT_INVALID_RESPONSE'); }
      chunks.push(part.value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new STTError('STT_INVALID_RESPONSE');
    return result;
  } catch (error) {
    if (error instanceof STTError) throw error;
    throw new STTError('STT_INVALID_RESPONSE');
  } finally { reader.releaseLock(); }
}

export function httpTranscriber(provider: HTTPSTTProvider, options: {
  key: () => Promise<string | undefined>;
  endpoint?: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Transcriber {
  return async (wav, signal) => {
    validateWav(wav);
    if (signal?.aborted) throw new STTError('STT_CANCELLED');
    const model = STT_PROVIDERS[provider].model;
    const form = new FormData();
    const headers: Record<string, string> = {};
    let url: string;
    // Resolve the selected endpoint before accessing a credential.
    if (provider === 'microsoft') {
      const origin = microsoftEndpoint(await options.endpoint?.());
      url = `${origin}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;
      form.set('definition', JSON.stringify({enhancedMode: {enabled: true, model}}));
    } else if (provider === 'elevenlabs') {
      url = 'https://api.elevenlabs.io/v1/speech-to-text'; form.set('model_id', model);
      form.set('tag_audio_events', 'false'); form.set('diarize', 'false');
    } else if (provider === 'openai') {
      url = 'https://api.openai.com/v1/audio/transcriptions'; form.set('model', model); form.set('response_format', 'json');
    } else {
      url = 'https://sync.assemblyai.com/v1/transcribe'; headers['X-AAI-Model'] = model;
    }
    let key: string | undefined;
    try { key = await options.key(); } catch { throw new STTError('STT_KEY_REQUIRED'); }
    if (!key) throw new STTError('STT_KEY_REQUIRED');
    if (key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) throw new STTError('STT_AUTH');
    if (signal?.aborted) throw new STTError('STT_CANCELLED');
    if (provider === 'microsoft') headers['Ocp-Apim-Subscription-Key'] = key;
    else if (provider === 'elevenlabs') headers['xi-api-key'] = key;
    else headers.Authorization = provider === 'openai' ? `Bearer ${key}` : key;
    key = undefined;
    form.set(provider === 'microsoft' || provider === 'assemblyai' ? 'audio' : 'file',
      new Blob([new Uint8Array(wav)], {type:'audio/wav'}), 'speech.wav');
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 85000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      // Never follow a redirect with a key or recording, retry, or switch providers.
      const response = await (options.fetch ?? fetch)(url, {method:'POST', headers, body:form, redirect:'error', signal:combined});
      if (!response.ok) {
        await response.body?.cancel();
        if ([401,403].includes(response.status)) throw new STTError('STT_AUTH');
        if ([402,429].includes(response.status)) throw new STTError('STT_QUOTA');
        throw new STTError('STT_UNAVAILABLE');
      }
      const body = await boundedJSON(response);
      if (provider === 'microsoft' && !Array.isArray(body.combinedPhrases)) throw new STTError('STT_INVALID_RESPONSE');
      const text = provider === 'microsoft' ? body.combinedPhrases.map((p: any) => {
        if (typeof p?.text !== 'string') throw new STTError('STT_INVALID_RESPONSE');
        return p.text;
      }).join(' ') : body.text;
      if (typeof text !== 'string' || text.length > 4000) throw new STTError('STT_INVALID_RESPONSE');
      if (!text.trim()) throw new STTError('STT_NO_TEXT');
      return text.trim();
    } catch (error) {
      if (signal?.aborted) throw new STTError('STT_CANCELLED');
      if (timeout.aborted) throw new STTError('STT_TIMEOUT');
      if (error instanceof STTError) throw error;
      throw new STTError('STT_UNAVAILABLE');
    }
  };
}
