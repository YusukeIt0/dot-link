import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';

const AAD = Buffer.from('dot-link:polar-health:v1');
const MAX = 8 * 1024 * 1024;
/** Bytes were read, but the encrypted payload did not authenticate or decode. */
export class InvalidHealthVaultPayload extends Error {}

/** Encrypt the complete snapshot, including consent, timestamps, indexes and tokens.
 * Only format/version, nonce and ciphertext length are visible on disk. */
export class HealthVault {
  readonly path:string;
  fingerprint?:string;
  private checked?:{identity:string;digest:string};
  constructor(path: string) {this.path=path;}
  exists() { return existsSync(this.path); }
  matches(fingerprint:string) {
    const file=lstatSync(this.path,{throwIfNoEntry:false,bigint:true});
    if(!file?.isFile()||file.size>MAX)return false;
    const identity=[file.dev,file.ino,file.size,file.mtimeNs,file.ctimeNs].join('/');
    if(this.checked?.identity!==identity)this.checked={identity,digest:createHash('sha256').update(readFileSync(this.path)).digest('hex')};
    return this.checked.digest===fingerprint;
  }
  private prepare() {
    mkdirSync(dirname(this.path), {recursive:true, mode:0o700});
    for (const path of [dirname(this.path), this.path]) {
      if (!existsSync(path)) continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (path === this.path ? !info.isFile() : !info.isDirectory())) throw new Error('HEALTH_STORAGE_UNAVAILABLE');
      chmodSync(path, path === this.path ? 0o600 : 0o700);
    }
  }
  read(key: Buffer): unknown {
    this.prepare();
    if (key.length !== 32 || lstatSync(this.path).size > MAX) throw new Error('HEALTH_STORAGE_UNAVAILABLE');
    const bytes = readFileSync(this.path);
    if (bytes.length < 33 || bytes[0] !== 1) throw new Error('HEALTH_STORAGE_UNAVAILABLE');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1,13));
    decipher.setAAD(AAD); decipher.setAuthTag(bytes.subarray(13,29));
    let result: unknown;
    try { result=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8')); }
    catch { throw new InvalidHealthVaultPayload('HEALTH_STORAGE_UNAVAILABLE'); }
    this.fingerprint=createHash('sha256').update(bytes).digest('hex');
    return result;
  }
  write(key: Buffer, value: unknown, prepared?: (fingerprint:string)=>void|(()=>void)) {
    this.prepare();
    const plain = Buffer.from(JSON.stringify(value));
    if (key.length !== 32 || plain.length > MAX - 29) throw new Error('HEALTH_STORAGE_UNAVAILABLE');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(AAD);
    let bytes: Buffer;
    try { bytes = Buffer.concat([Buffer.from([1]),nonce,Buffer.alloc(16),cipher.update(plain),cipher.final()]); }
    finally { plain.fill(0); }
    cipher.getAuthTag().copy(bytes,13);
    const temp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    let release:void|(()=>void)=undefined;
    try {
      writeFileSync(temp,bytes,{flag:'wx',mode:0o600});
      const fingerprint=createHash('sha256').update(bytes).digest('hex');
      release=prepared?.(fingerprint);
      renameSync(temp,this.path);
      this.fingerprint=fingerprint;
    }
    finally { try {if (existsSync(temp)) unlinkSync(temp);} finally {release?.();} }
  }
  remove() { this.prepare(); if (this.exists()) unlinkSync(this.path); this.fingerprint=undefined; }
}

/** The signed app owns the Keychain item. No secrets in argv, logs or environment. */
export function healthKeychain(executable?: string) {
  return (operation: 'read' | 'create' | 'delete' | 'authorize'): Promise<Buffer | undefined> => new Promise((resolve,reject) => {
    if (!executable) { reject(new Error('HEALTH_KEY_UNAVAILABLE')); return; }
    // User-driven prompts need time for authentication; unattended reads stay short.
    execFile(executable,['--health-credential',operation],{timeout:operation==='read'?15_000:300_000,killSignal:'SIGKILL',maxBuffer:2048},(error,stdout) => {
      if (error) { reject(new Error('HEALTH_KEY_UNAVAILABLE')); return; }
      try {
        const result = JSON.parse(stdout);
        if (result.status !== 'ok') throw new Error();
        if (operation === 'delete' || operation === 'authorize') { resolve(undefined); return; }
        if (typeof result.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(result.key)) throw new Error();
        const key = Buffer.from(result.key,'base64'); if (key.length !== 32) throw new Error(); resolve(key);
      } catch { reject(new Error('HEALTH_KEY_UNAVAILABLE')); }
    });
  });
}
