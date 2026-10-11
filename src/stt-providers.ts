import catalog from './stt-providers.json' with { type: 'json' };

// Shared by API requests, relay status and the native app (which reads the JSON).
export const STT_PROVIDERS = catalog;
export type STTProvider = keyof typeof catalog;
export type CloudSTTProvider = Exclude<STTProvider, 'whisper'>;
export function readSTTProvider(value: unknown): STTProvider | undefined {
  return typeof value === 'string' && Object.hasOwn(catalog, value) ? value as STTProvider : undefined;
}
export function sttLabel(provider: STTProvider): string {
  const entry = catalog[provider];
  return `${entry.name} ${entry.model}`;
}
