import type { AppImageAsset, EvenAppBridge } from '@evenrealities/even_hub_sdk';

export const MAX_PHOTOS = 4;
export const MAX_PHOTO_BYTES = 512 * 1024;
export const MAX_PHOTO_EDGE = 2048;
// Base64 expansion plus the existing text/envelope budget. Only utterance POSTs use this limit.
export const PHOTO_REQUEST_BYTES = MAX_PHOTOS * Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 32768;
export interface PhotoAttachment { mimeType: 'image/jpeg'; data: string; }

/** These are the only SDK-specific photo calls. Both return the same draft format. */
export async function selectPhoto(source: 'camera' | 'album', bridge: Pick<EvenAppBridge, 'captureImageFromCamera' | 'pickImageFromAlbum'>): Promise<PhotoAttachment | null> {
  const asset = source === 'camera' ? await bridge.captureImageFromCamera() : await bridge.pickImageFromAlbum();
  return asset ? preparePhoto(asset) : null;
}

/** Re-encode pixels rather than forwarding the original: no EXIF/GPS or host path leaves the phone. */
export async function preparePhoto(asset: AppImageAsset): Promise<PhotoAttachment> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(asset.mimeType) ||
    typeof asset.base64 !== 'string' || !asset.base64.length || asset.base64.length > 28 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.base64)) throw new Error('Photo could not be prepared');
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('Photo could not be decoded'));
      image.src = `data:${asset.mimeType};base64,${asset.base64}`;
    });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60_000_000) throw new Error('Photo dimensions exceed the limit');
    const canvas = document.createElement('canvas');
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image processing is unavailable');
      for (const edge of [MAX_PHOTO_EDGE, 1536, 1024]) {
        const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.85, 0.7, 0.5]) {
          const url = canvas.toDataURL('image/jpeg', quality);
          if (!url.startsWith('data:image/jpeg;base64,')) throw new Error('JPEG encoding is unavailable');
          const data = url.slice('data:image/jpeg;base64,'.length);
          if (data.length <= Math.floor(MAX_PHOTO_BYTES / 3) * 4) return { mimeType: 'image/jpeg', data };
        }
      }
      throw new Error('Photo exceeds the size limit');
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { image.onload = null; image.onerror = null; image.src = ''; }
}
