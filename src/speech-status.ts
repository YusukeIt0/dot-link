export type STTProvider = 'whisper' | 'soniox';

export function readSTTProvider(value: unknown): STTProvider | undefined {
  return value === 'whisper' || value === 'soniox' ? value : undefined;
}

// SpeechSynthesis uses this client device. It does not expose a model ID.
export function speechDevice(userAgent: string, touchPoints = 0): 'iPhone' | 'Mac' | 'Device' {
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)) return 'iPhone';
  return /Macintosh|Mac OS X/.test(userAgent) ? 'Mac' : 'Device';
}

export function speechStatus(provider: STTProvider | undefined, online: boolean, ttsEnabled: boolean,
  ttsAvailable: boolean, device: ReturnType<typeof speechDevice>): string {
  const stt = !online ? '—' : provider === 'whisper' ? 'Whisper' : provider === 'soniox' ? 'Soniox' : '—';
  const tts = !ttsAvailable ? '—' : ttsEnabled ? device : 'OFF';
  return `STT:${stt} / TTS:${tts}`;
}
