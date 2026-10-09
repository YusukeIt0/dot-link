import { access, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { run, activateAgent, unloadAgent } from './lib/setup.mjs';
import { ownedService, serviceNames } from './lib/service-management.mjs';

const requestedDirectory = process.argv.indexOf('--directory');
const directory = requestedDirectory >= 0 ? process.argv[requestedDirectory + 1] : fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const action = process.argv[2] ?? 'status';
if (!['status', 'start', 'stop', 'uninstall'].includes(action)) throw new Error('Usage: node scripts/manage.mjs status|start|stop|uninstall');
if (process.platform !== 'darwin') throw new Error('macOS is required');
const domain = `gui/${process.getuid()}`;
const services = [];
// Validate every job before changing any of them. Never take over another install.
for (const name of serviceNames.filter(name => !process.argv.includes('--voice-only') || name !== 'menu')) {
  const label = `local.even-g2-dot.${name}`, path = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
  if (!await access(path).then(()=>true,()=>false)) continue;
  const plist = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]));
  if (!ownedService(plist,directory,name)) throw new Error(`Different installation owns ${label}; no changes made`);
  services.push({name,label,path,loaded:await run('/bin/launchctl',['print',`${domain}/${label}`]).then(()=>true,()=>false)});
}
if (action === 'status') console.log(JSON.stringify({services:services.map(({name,loaded})=>({name,loaded}))}));
else if (action === 'start') {
  for (const service of services) if (!service.loaded) await activateAgent(domain,service.label,service.path);
  console.log('Registered services started. Check the connection status before speaking. / 登録済みサービスを起動しました。接続状態を確認してください。');
} else {
  for (const service of [...services].reverse()) if (service.loaded) await unloadAgent(`${domain}/${service.label}`);
  if (action === 'uninstall') {
    const backup = join(directory,'.runtime',`uninstalled-${Date.now()}`); await mkdir(backup,{recursive:true,mode:0o700});
    for (const service of services) await rename(service.path,join(backup,`${service.label}.plist`));
    console.log('Login services removed. Project files, history, and Tailscale remain. / ログイン時起動を解除しました。アプリのファイル・履歴・Tailscaleは保持しています。');
  } else console.log('All registered Dot Link services stopped until started again or next login. / 登録済みサービス全体を停止しました。次の起動操作またはログインで再開します。');
}
