import { STT_PROVIDERS, sttLabel, type STTProvider } from './stt-providers.ts';
export { readSTTProvider, type STTProvider } from './stt-providers.ts';

// SpeechSynthesis uses this client device. It does not expose a model ID.
export function speechDevice(userAgent: string, touchPoints = 0): 'iPhone' | 'Mac' | 'Device' {
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)) return 'iPhone';
  return /Macintosh|Mac OS X/.test(userAgent) ? 'Mac' : 'Device';
}

export function speechStatus(provider: STTProvider | undefined, online: boolean, ttsEnabled: boolean,
  ttsAvailable: boolean, device: ReturnType<typeof speechDevice>, model?: unknown): string {
  const actualModel = typeof model === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(model) ? model : undefined;
  const stt = !online || !provider ? '—' : actualModel ? `${STT_PROVIDERS[provider].name} ${actualModel}` : sttLabel(provider);
  const tts = !ttsAvailable ? '—' : ttsEnabled ? device : 'OFF';
  return `STT:${stt} / TTS:${tts}`;
}
