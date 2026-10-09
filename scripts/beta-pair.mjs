import { writeFile, chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import { PairingAuthority } from '../server/pairing-authority.ts';
import { tailscale } from './lib/setup.mjs';
import { appOrigin } from '../src/relay-origin.ts';

const authority = new PairingAuthority(resolve('.runtime/pairing'));
if (process.argv[2] === 'revoke-all') {
  authority.revokeAll();
  console.log('All beta invitations and device sessions revoked. Existing legacy development pairing is separate.');
} else {
  const origin = process.argv[2];
  if (origin) appOrigin(origin);
  const relay = (await tailscale()).origin;
  if (!relay) throw new Error('Connect Tailscale on this Mac first');
  const invitation = authority.issue(relay, origin);
  await mkdir('.runtime', { recursive: true, mode: 0o700 });
  await writeFile('.runtime/beta-pairing.txt', JSON.stringify(invitation), { mode: 0o600 });
  await chmod('.runtime/beta-pairing.txt', 0o600);
  await QRCode.toFile('.runtime/beta-pairing.png', JSON.stringify(invitation), {width:640,margin:3});
  await chmod('.runtime/beta-pairing.png', 0o600);
  console.log('Pairing QR prepared in .runtime/beta-pairing.png. Valid for two minutes and one use. Do not share it.');
}
