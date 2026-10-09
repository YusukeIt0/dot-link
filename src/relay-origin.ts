/** Current macOS transport: an explicitly paired Tailscale HTTPS host, never a URL proxy. */
export function relayOrigin(input: string): string {
  if (input.length > 255 || input !== input.trim()) throw new Error('Invalid relay address');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/.test(url.hostname)) {
    throw new Error('Use the HTTPS address generated on your own Mac');
  }
  return url.origin;
}

export function appOrigin(input: string): string {
  // Opaque packaged WebView origins may be explicitly approved by the Mac operator.
  // Never include "null" by default or infer approval from an incoming request.
  if (input === 'null') return input;
  const url = new URL(input);
  // The installed iOS host was observed serving packages from a local HTTP
  // listener. This is an explicitly issued CORS source, never a relay target.
  const packagedLoopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
    Number(url.port) >= 1024 && Number(url.port) <= 65535;
  if (url.origin !== input || (url.protocol !== 'https:' && !packagedLoopback) || url.username || url.password) throw new Error('Invalid app origin');
  return url.origin;
}

export interface PairingInvite { version: 1; origin: string; code: string; expiresAt: number; }
export function parseInvite(raw: string, now = Date.now()): PairingInvite {
  if (raw.length > 1024) throw new Error('Invalid pairing code');
  const value = JSON.parse(raw);
  if (!value || value.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(value.code) ||
      typeof value.expiresAt !== 'number' || value.expiresAt <= now || value.expiresAt > now + 125000 ||
      Object.keys(value).some(key => !['version', 'origin', 'code', 'expiresAt'].includes(key))) throw new Error('Invalid or expired pairing code');
  return { version: 1, origin: relayOrigin(value.origin), code: value.code, expiresAt: value.expiresAt };
}
