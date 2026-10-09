import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

mkdirSync('.runtime', { recursive: true, mode: 0o700 });
for (const name of ['mcp-key', 'device-key', 'notification-key']) {
  try { writeFileSync(`.runtime/${name}`, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
console.log('Private keys are ready in .runtime/. Existing keys were preserved. No key values were printed.');
