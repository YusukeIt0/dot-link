import { readFile, chmod } from 'node:fs/promises';
import QRCode from 'qrcode';
import { tailscale, privateOrigin } from './lib/setup.mjs';

const origin = new URL(privateOrigin(process.argv[2] ?? (await tailscale()).origin));
const key = (await readFile('.runtime/device-key', 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid device key');
origin.hash = new URLSearchParams({pair:key}).toString();
await QRCode.toFile('.runtime/device-pairing.png', origin.href, {width:640,margin:3});
await chmod('.runtime/device-pairing.png', 0o600);
console.log('Private pairing QR saved. Keep it private; it grants device access.');
