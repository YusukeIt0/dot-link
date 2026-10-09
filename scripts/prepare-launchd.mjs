import { resolve } from 'node:path';
import { tailscale, prepareAgents } from './lib/setup.mjs';
const origin = process.argv[2] ?? (await tailscale()).origin;
await prepareAgents(resolve('.'), origin);
console.log('LaunchAgents prepared. Use the menu app to enable automatic startup.');
