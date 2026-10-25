import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_PHOTOS, MAX_PHOTO_BYTES, MAX_PHOTO_EDGE } from '../src/photo-attachments.ts';

export class PhotoStorageFullError extends Error {
  constructor() { super('Pending photo storage is full'); }
}
export const MAX_PENDING_PHOTO_BYTES = 8 * 1024 * 1024;
/** Bounded JPEG header inspection; the relay never executes or interprets uploaded files. */
function validJpeg(data: string): boolean {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_PHOTO_BYTES || bytes.toString('base64') !== data || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  let offset = 2, dimensions = false;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) return dimensions; // The scan follows the bounded frame header.
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return false;
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || width > MAX_PHOTO_EDGE || height > MAX_PHOTO_EDGE) return false;
      dimensions = true;
    }
    offset += length;
  }
  return false;
}
export const photoSchema = z.object({
  mimeType: z.literal('image/jpeg'),
  data: z.string().min(4).max(Math.ceil(MAX_PHOTO_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).refine(validJpeg),
}).strict();
export const photosSchema = z.array(photoSchema).max(MAX_PHOTOS);
export const photoDigest = (photo: { data: string }) => createHash('sha256').update(photo.data).digest('hex');
export const photoBytes = (photos: readonly { data: string }[] = []) => photos.reduce((n, photo) => n + Buffer.byteLength(photo.data, 'base64'), 0);
