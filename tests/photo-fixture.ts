import { readFileSync } from 'node:fs';
export function photoFixture(size?: number) {
  const original = readFileSync(new URL('./fixtures/photo-green.jpg', import.meta.url));
  const parts = [original.subarray(0, 2)];
  let remaining = (size ?? original.length) - original.length;
  while (remaining > 0) {
    const length = Math.min(remaining, 60_000);
    if (length < 4) throw new Error('Padding must fit a JPEG application segment');
    const segment = Buffer.alloc(length); segment[0] = 0xff; segment[1] = 0xef;
    segment.writeUInt16BE(length - 2, 2); parts.push(segment); remaining -= length;
  }
  parts.push(original.subarray(2));
  return { mimeType: 'image/jpeg' as const, data: Buffer.concat(parts).toString('base64') };
}
