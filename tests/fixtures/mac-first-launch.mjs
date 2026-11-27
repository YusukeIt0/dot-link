import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { mock } from 'node:test';

// Run the real helper in a fresh process. External network and relay health
// checks are local fixtures; installation discovery and journal handling are real.
const trace = name => appendFileSync(join(homedir(), 'trace'), name + '\n');
const lib = file => new URL('../../scripts/lib/' + file, import.meta.url);
const setup = await import(lib('setup.mjs'));
mock.module(lib('setup.mjs'), {namedExports: {
  ...setup,
  tailscale: async () => { trace('network'); return {state: 'ready'}; },
  run: async (file, args) => {
    if (file === process.execPath && basename(args[0]) === 'setup-status.mjs') {
      trace('relay'); return '{}';
    }
    throw new Error('Unexpected external command in startup fixture');
  },
}});

const install = await import(lib('mac-install.mjs'));
mock.module(lib('mac-install.mjs'), {namedExports: {
  ...install,
  discoverInstallation: async () => {
    trace('discover');
    if (process.env.DOTLINK_TEST_STALL_DISCOVERY === '1') {
      mock.timers.enable({apis: ['setTimeout']});
      queueMicrotask(() => mock.timers.tick(60_000));
      return new Promise(() => {});
    }
    return install.discoverInstallation();
  },
}});

const update = await import(lib('app-update.mjs'));
mock.module(lib('app-update.mjs'), {namedExports: {
  ...update,
  finishUpdate: (directory, options) => {
    trace('recover');
    return update.finishUpdate(directory, {...options, launchCleanup: () => {}});
  },
}});
