import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, mkdir, copyFile, open, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ownedService, serviceNames } from './service-management.mjs';
import { setupError } from './setup-failure.mjs';

const execute = promisify(execFile);
export const run = async (file, args, options = {}) => (await execute(file, args, { timeout: 12000, maxBuffer: 256000, ...options })).stdout.trim();
// macOS bundles GUI and CLI in one executable. LaunchAgents have no shell
// markers, so explicitly select CLI mode (official Tailscale CLI guidance).
export const runTailscale = (file, args) => run(file, args, { env: { ...process.env, TAILSCALE_BE_CLI: '1' } });
export async function executable(candidates) {
  for (const candidate of candidates) { try { await access(candidate, constants.X_OK); return candidate; } catch {} }
  return undefined;
}
export function privateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw setupError('TAILSCALE_DNS_UNAVAILABLE', 'TailscaleのHTTPS接続先を確認してください。');
  return url.origin;
}
export function originFromStatus(status) {
  if (status.BackendState === 'NeedsLogin') throw setupError('TAILSCALE_LOGIN_REQUIRED', 'Tailscaleを開いてログインしてください。iPhoneでも同じアカウントを使います。');
  if (status.BackendState === 'NeedsMachineAuth') throw setupError('TAILSCALE_APPROVAL_REQUIRED', 'Tailscaleの管理画面で、このMacの参加を承認してください。');
  if (status.BackendState === 'Stopped') throw setupError('TAILSCALE_STOPPED', 'Tailscaleが停止しています。Tailscaleを開いて接続をオンにしてください。');
  if (status.BackendState !== 'Running') throw setupError('TAILSCALE_NOT_READY', 'Tailscaleの起動を待っています。続く場合はTailscaleを開いて確認してください。');
  if (!status.Self?.DNSName) throw setupError('TAILSCALE_DNS_UNAVAILABLE', 'Tailscaleの端末名を取得できません。管理画面でMagicDNSとHTTPSを確認してください。');
  return privateOrigin(`https://${status.Self.DNSName.replace(/\.$/, '')}`);
}
export function serveState(config, origin) {
  const host = `${new URL(privateOrigin(origin)).hostname}:443`;
  if (Object.values(config.AllowFunnel ?? {}).some(Boolean)) return 'public';
  if (config.TCP?.['443'] && config.TCP['443'].HTTPS !== true) return 'conflict';
  if (Object.keys(config.Web ?? {}).some(key => key !== host && key.endsWith(':443'))) return 'conflict';
  const handler = config.Web?.[host]?.Handlers?.['/'];
  if (!handler) return 'missing';
  return config.TCP?.['443']?.HTTPS === true && handler.Proxy === 'http://127.0.0.1:3462' ? 'ready' : 'conflict';
}
export async function tailscale({ candidates = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', join(homedir(), 'Applications/Tailscale.app/Contents/MacOS/Tailscale'), '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'], execute = runTailscale } = {}) {
  const bin = await executable(candidates);
  if (!bin) throw setupError('TAILSCALE_NOT_INSTALLED', 'Tailscaleをインストールしてログインしてください。');
  let status, config;
  try { status = JSON.parse(await execute(bin, ['status', '--json'])); }
  catch (error) {
    // The CLI can exit nonzero while returning a valid NeedsLogin state.
    try { status = JSON.parse(error.stdout); } catch { throw setupError('TAILSCALE_STATUS_FAILED', 'Tailscaleを開いて接続してください。', error); }
  }
  const origin = originFromStatus(status);
  try { config = JSON.parse(await execute(bin, ['serve', 'status', '--json'])); } catch (error) { throw setupError('TAILSCALE_SERVE_STATUS_FAILED', 'Tailscaleの接続設定を読み取れません。Tailscaleを開いて確認してください。', error); }
  return { bin, origin, state: serveState(config, origin) };
}
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function launchAgent(label, args, directory, environment = {}, menu = false) {
  const log = join(directory, '.runtime', `${label.split('.').at(-1)}-service.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([k,v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key>${menu ? '<dict><key>SuccessfulExit</key><false/></dict>' : '<true/>'}
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>`;
}
export async function activateAgent(domain, label, path, { execute = run, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // bootout returns before launchd has always finished releasing the old job.
  // A retry must inspect the label first, rather than spawn a second process.
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await execute('/bin/launchctl', ['print', `${domain}/${label}`]).then(() => true, () => false)) return;
    try { await execute('/bin/launchctl', ['bootstrap', domain, path]); return; }
    catch (error) { lastError = error; if (attempt < 5) await wait(200 * (attempt + 1)); }
  }
  throw setupError('SERVICE_REGISTRATION_FAILED', '自動起動を登録できませんでした。Macにログインした状態で、もう一度設定してください。', lastError);
}
export async function unloadAgent(target, { execute = run, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  await execute('/bin/launchctl', ['bootout', target]);
  // Active long-poll requests can take 15 seconds to drain; launchd may also
  // wait for its termination grace period. Do not mistake this for a failure.
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!await execute('/bin/launchctl', ['print', target]).then(() => true, () => false)) return;
    await wait(500);
  }
  throw setupError('SERVICE_STOP_TIMEOUT', '以前の起動処理が終了待ちです。少し待ってから接続設定を整えてください。');
}
export async function assertOwnedAgents(directory, { destination = join(homedir(), 'Library/LaunchAgents'), execute = run } = {}) {
  for (const name of serviceNames) {
    const path = join(destination, `local.even-g2-dot.${name}.plist`);
    try { await access(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let plist;
    try { plist = JSON.parse(await execute('/usr/bin/plutil', ['-convert','json','-o','-',path])); }
    catch { throw setupError('EXISTING_SERVICE_UNREADABLE', '既存の起動設定を確認できません。設定は変更していません。 / Cannot verify an existing login service; no changes made.'); }
    if (!ownedService(plist,directory,name)) throw setupError('EXISTING_SERVICE_CONFLICT', '別の配置先が起動設定を使用しています。設定は変更していません。 / Another installation owns these login services; no changes made.');
  }
}
export async function prepareAgents(directory, origin, { install = false, menu = false } = {}) {
  origin = privateOrigin(origin);
  await assertOwnedAgents(directory);
  const tunnel = await executable([join(directory, '.runtime/bin/tunnel-client'), '/opt/homebrew/bin/tunnel-client', '/usr/local/bin/tunnel-client']);
  if (!tunnel) throw setupError('TUNNEL_CLIENT_MISSING', 'Dot接続用のtunnel-clientがありません。導入手順を確認してください。');
  // Prefer stable installation links over a versioned Homebrew Cellar path.
  const node = await executable([join(directory, '.runtime/bin/node'), '/opt/homebrew/bin/node', '/usr/local/bin/node']) ?? process.execPath;
  const entries = [
    ['bridge', [node, join(directory, 'server/main.ts')], { DOT_CALLBACK_HOSTS: 'connectors.api.openai.com' }],
    ['device', [node, join(directory, 'server/device-main.ts')], { G2_DEVICE_ORIGIN: origin }],
    ['tunnel', [tunnel, 'run', '--profile-file', join(directory, '.runtime/tunnel.yaml')], {}],
  ];
  if (menu) entries.push(['menu', [join(directory, '.runtime/notification-menu/Dot Notification Lab.app/Contents/MacOS/DotNotificationLab')], {}]);
  const destination = join(homedir(), 'Library/LaunchAgents');
  await mkdir(destination, { recursive: true });
  await mkdir(join(directory, '.runtime'), { recursive: true, mode: 0o700 });
  const changed = [];
  for (const [name, args, environment] of entries) {
    const label = `local.even-g2-dot.${name}`, path = join(destination, `${label}.plist`);
    const content = launchAgent(label, args, directory, environment, name === 'menu');
    const previous = await readFile(path, 'utf8').catch(() => undefined);
    const log = join(directory, '.runtime', `${name}-service.log`);
    const handle = await open(log, 'a', 0o600); await handle.close(); await chmod(log, 0o600);
    const modified = previous !== content;
    if (modified) {
      if (previous !== undefined) {
        const backups = join(directory, '.runtime/setup-backups');
        await mkdir(backups, { recursive: true, mode: 0o700 });
        await copyFile(path, join(backups, `${Date.now()}-${label}.plist`));
      }
      await writeFile(path, content, { mode: 0o600 });
      changed.push(name);
    }
    if (!install) continue;
    const domain = `gui/${process.getuid()}`, target = `${domain}/${label}`;
    const loaded = await run('/bin/launchctl', ['print', target]).then(() => true, () => false);
    try {
      await run('/bin/launchctl', ['enable', target]);
      if (loaded && modified) await unloadAgent(target);
      if (!loaded || modified) await activateAgent(domain, label, path);
    } catch (error) {
      if (modified && previous !== undefined) {
        await writeFile(path, previous, { mode: 0o600 });
        await activateAgent(domain, label, path).catch(() => {});
      }
      throw error;
    }
  }
  return changed;
}
