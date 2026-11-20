import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const nonceSize = 12;
const headerSize = 1 + nonceSize + 16;

export function sealArchive(key: Buffer, aad: string, plain: Buffer): Buffer {
  const nonce = randomBytes(nonceSize);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
}

export function openArchive(key: Buffer, aad: string, sealed: Uint8Array): Buffer {
  if (sealed.length < headerSize || sealed[0] !== 1) throw new Error('HISTORY_ARCHIVE_UNAVAILABLE');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 1 + nonceSize));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(1 + nonceSize, headerSize));
  const first = decipher.update(sealed.subarray(headerSize));
  try { return Buffer.concat([first, decipher.final()]); }
  finally { first.fill(0); }
}
