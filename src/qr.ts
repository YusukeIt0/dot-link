import jsQR from 'jsqr';
import type { AppImageAsset } from '@evenrealities/even_hub_sdk';

export type QrPhotoFailure = 'QR_IMAGE_FORMAT' | 'QR_IMAGE_DATA' | 'QR_IMAGE_DECODE' | 'QR_IMAGE_SIZE' | 'QR_CANVAS' | 'QR_NOT_FOUND';
export class QrPhotoError extends Error {
  readonly code: QrPhotoFailure;
  constructor(code: QrPhotoFailure) { super(code); this.name = 'QrPhotoError'; this.code = code; }
}

/** Accept known raster formats only; never load the host-side path or a remote URL. */
export function photoDataUrl(asset: AppImageAsset): string {
  if (typeof asset.base64 !== 'string' || !asset.base64 || asset.base64.length > 48000000) throw new QrPhotoError('QR_IMAGE_DATA');
  const prefix = /^data:([^;,]+);base64,/i.exec(asset.base64);
  const raw = asset.base64.slice(prefix?.[0].length ?? 0).replace(/\s/g, '');
  if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) throw new QrPhotoError('QR_IMAGE_DATA');
  let mime = (prefix?.[1] ?? asset.mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpg' || mime === 'image/pjpeg') mime = 'image/jpeg';
  // The actual bytes take precedence over an empty/generic/incorrect host MIME.
  if (raw.startsWith('/9j/')) mime = 'image/jpeg';
  else if (raw.startsWith('iVBORw0KGgo')) mime = 'image/png';
  else if (raw.startsWith('UklGR')) mime = 'image/webp';
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'].includes(mime)) throw new QrPhotoError('QR_IMAGE_FORMAT');
  return `data:${mime};base64,${raw}`;
}

/** Decode in memory at bounded canvas sizes. Camera images are never uploaded. */
export async function decodePairingQR(asset: AppImageAsset): Promise<string> {
  const image = new Image();
  image.src = photoDataUrl(asset);
  const canvas = document.createElement('canvas');
  try {
    try { await image.decode(); } catch { throw new QrPhotoError('QR_IMAGE_DECODE'); }
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    // 48 MP phone photos are valid inputs; each working canvas stays <= 2400 px.
    if (!width || !height || width * height > 80000000) throw new QrPhotoError('QR_IMAGE_SIZE');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new QrPhotoError('QR_CANVAS');
    const attempts = [
      { crop: 1, max: 1600 },
      { crop: 1, max: 2400 },
      { crop: 0.65, max: 2000 },
    ];
    for (const attempt of attempts) {
      const sourceWidth = Math.round(width * attempt.crop), sourceHeight = Math.round(height * attempt.crop);
      const scale = Math.min(1, attempt.max / Math.max(sourceWidth, sourceHeight));
      canvas.width = Math.round(sourceWidth * scale); canvas.height = Math.round(sourceHeight * scale);
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, (width - sourceWidth) / 2, (height - sourceHeight) / 2,
        sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      try {
        const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
        if (result && result.data.length <= 1024) return result.data;
      } finally { pixels.data.fill(0); context.clearRect(0, 0, canvas.width, canvas.height); }
    }
    throw new QrPhotoError('QR_NOT_FOUND');
  } finally { canvas.width = 0; canvas.height = 0; image.src = ''; }
}
