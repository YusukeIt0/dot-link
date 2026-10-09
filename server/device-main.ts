import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateActivity } from './update-activity.ts';
import { deviceServer } from './device.ts';
import { localTranscriber } from './asr.ts';
import { LatencyLog } from './latency.ts';
import { deviceName } from './device-name.ts';
import { PairingAuthority } from './pairing-authority.ts';

const origin = process.env.G2_DEVICE_ORIGIN;
if (!origin) throw new Error('G2_DEVICE_ORIGIN must be set to the private HTTPS origin');
const updateActivity = new UpdateActivity(resolve('.runtime'));
const transcribe = localTranscriber();
const server = deviceServer({ origin, directory: process.env.DOT_LINK_APP_RUNTIME === '1' ? fileURLToPath(new URL('../dist', import.meta.url)) : resolve('dist'), deviceName: await deviceName(),
  updateActivity,
  pairing: new PairingAuthority(resolve('.runtime/pairing')),
  appOrigins: (process.env.G2_APP_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  token: readFileSync('.runtime/device-key', 'utf8').trim(), transcribe: async wav => { const finished = updateActivity.begin(); try { return await transcribe(wav); } finally { finished(); } }, latency: new LatencyLog(resolve('.runtime/latency-device.jsonl')) });
server.requestTimeout = 100000;
server.headersTimeout = 10000;
server.listen(3462, '127.0.0.1', () => console.log('Private G2 device server listening on 127.0.0.1:3462'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
