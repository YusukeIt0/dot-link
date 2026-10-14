export const wakeManifest: {
  files: Record<string, { bytes: number; sha256: string; local?: string; gzip?: string; gzipSha256?: string }>;
};
export function verifyWakeAssets(root: string): Promise<void>;
export function sha256(data: Uint8Array): string;
