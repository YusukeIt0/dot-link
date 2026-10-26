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

/** Bound cumulative page expansion for one source file, including repeated reads. */
export function boundedMapCompressors(maximumBytes=96*1024*1024) {
  let decodedBytes=0;
  return {ZSTD:(input:Uint8Array,length:number)=>{
    decodedBytes+=length;
    if(!Number.isSafeInteger(decodedBytes)||decodedBytes>maximumBytes)throw new Error('Map decoded column limit');
    return decompressMapPage(input,length);
  }};
}
