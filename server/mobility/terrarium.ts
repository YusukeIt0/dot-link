import { inflateSync } from 'node:zlib';

const SIZE = 256;
const table = Uint32Array.from({length: 256}, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
  return x <= y && x <= z ? a : y <= z ? b : c;
}

/** Deliberately accepts only the provider's 256px, 8-bit RGB/RGBA, non-interlaced tiles. */
export function decodeTerrarium(png: Buffer): Float32Array {
  if (png.length > 512 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid terrain tile');
  let offset = 8, channels = 0, ended = false, seenData = false, dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    if (length > 512 * 1024 || offset + 12 + length > png.length) throw new Error('Invalid terrain chunk');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)) throw new Error('Terrain checksum mismatch');
    if (offset === 8 && type !== 'IHDR') throw new Error('Missing terrain header');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13 || data.readUInt32BE(0) !== SIZE || data.readUInt32BE(4) !== SIZE ||
          data[8] !== 8 || ![2,6].includes(data[9]!) || data[10] || data[11] || data[12]) throw new Error('Unsupported terrain encoding');
      channels = data[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      if (!channels || dataEnded) throw new Error('Invalid terrain data order');
      compressed.push(data); seenData = true;
    } else if (type === 'IEND') {
      if (length || !seenData || offset + 12 !== png.length) throw new Error('Invalid terrain end');
      ended = true; break;
    } else {
      if (seenData) dataEnded = true;
      // Unknown critical chunks and RGB transparency are rejected, not silently ignored.
      if (!(png[offset + 4]! & 32) || type === 'tRNS') throw new Error('Unsupported terrain chunk');
    }
    offset += length + 12;
  }
  if (!ended) throw new Error('Truncated terrain tile');
  const stride = SIZE * channels, expected = SIZE * (stride + 1);
  const raw = inflateSync(Buffer.concat(compressed), {maxOutputLength: expected});
  if (raw.length !== expected) throw new Error('Invalid terrain raster size');
  const pixels = Buffer.alloc(SIZE * stride), heights = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) throw new Error('Invalid terrain filter');
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= channels ? pixels[i - channels]! : 0,
        b = y ? pixels[i - stride]! : 0, c = y && x >= channels ? pixels[i - stride - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a,b,c);
      pixels[i] = (raw[y * (stride + 1) + 1 + x]! + predictor) & 255;
    }
    for (let x = 0; x < SIZE; x++) {
      const i = y * stride + x * channels;
      const height = pixels[i]! * 256 + pixels[i + 1]! + pixels[i + 2]! / 256 - 32768;
      heights[y * SIZE + x] = (channels === 4 && pixels[i + 3] !== 255) || height < -12000 || height > 9000 ? NaN : height;
    }
  }
  return heights;
}
