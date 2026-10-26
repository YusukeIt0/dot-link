import { zstdDecompressSync } from 'node:zlib';
import type { Compressors } from 'hyparquet';

/** Overture uses Zstandard. Enforce the decoded limit in the native decoder itself. */
export function decompressMapPage(input: Uint8Array, length: number): Uint8Array {
  if(!Number.isSafeInteger(length)||length<0||length>16*1024*1024)throw new Error('Map page limit');
  const output=zstdDecompressSync(input,{maxOutputLength:Math.max(1,length)});
  if(output.byteLength!==length)throw new Error('Map page length mismatch');
  return output;
}
export const mapCompressors:Compressors={ZSTD:decompressMapPage};
