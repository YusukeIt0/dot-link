import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

export const serviceNames = ['bridge', 'device', 'tunnel', 'menu'];
export function ownedService(plist, directory, name, { home = homedir() } = {}) {
  if (!serviceNames.includes(name) || plist?.Label !== `local.even-g2-dot.${name}` ||
    plist.WorkingDirectory !== resolve(directory) || !Array.isArray(plist.ProgramArguments)) return false;
  const args = plist.ProgramArguments;
  const runtime = join(home, 'Applications/Dot Link.app/Contents/Resources/payload');
  if (plist.EnvironmentVariables?.DOT_LINK_APP_RUNTIME === '1') {
    if (plist.Program !== undefined) return false;
    if (name === 'bridge' || name === 'device') return args.length === 2 && args[0] === join(runtime, '.runtime/bin/node') &&
      args[1] === join(runtime, `server/${name === 'bridge' ? 'main' : 'device-main'}.ts`);
    if (name === 'tunnel') return args.length === 4 && args[0] === join(runtime, '.runtime/bin/tunnel-client') &&
      args[1] === 'run' && args[2] === '--profile-file' && args[3] === join(resolve(directory), '.runtime/tunnel.yaml');
    return false;
  }
  if (name === 'bridge' || name === 'device') return args[1] === join(resolve(directory), `server/${name === 'bridge' ? 'main' : 'device-main'}.ts`);
  if (name === 'tunnel') return args.includes(join(resolve(directory), '.runtime/tunnel.yaml'));
  return args[0] === join(resolve(directory), '.runtime/notification-menu/Dot Notification Lab.app/Contents/MacOS/DotNotificationLab');
}
