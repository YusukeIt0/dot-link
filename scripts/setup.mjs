import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tailscale, run, runTailscale, prepareAgents, executable, assertOwnedAgents } from './lib/setup.mjs';

// Output contains no keys, subprocess stderr, QR contents, or conversations.
const directoryIndex = process.argv.indexOf('--directory');
process.chdir(directoryIndex >= 0 ? resolve(process.argv[directoryIndex + 1]) : fileURLToPath(new URL('..', import.meta.url)));
const exists = path => access(path).then(() => true, () => false);
const voiceOnly = process.argv.includes('--voice-only');
async function output(result) {
  if ((process.argv[2] ?? 'status') === 'status') {
    // A small, secret-free diagnostic also covers checks launched by the GUI.
    const { origin, ...diagnostic } = result;
    await writeFile('.runtime/setup-status.json', JSON.stringify({ ...diagnostic, checkedAt: Date.now(), parentPID: process.ppid }), { mode: 0o600 }).catch(() => {});
  }
  console.log(JSON.stringify(result));
}
async function inspect() {
  const issues = [];
  let ts;
  try { ts = await tailscale(); } catch (error) { issues.push(error.message); }
  if (ts?.state === 'missing') issues.push('接続設定を自動で整えるボタンを押してください。');
  if (ts?.state === 'conflict') issues.push('Tailscaleの同じ接続先を別のアプリが使用しています。既存設定は変更していません。');
  if (ts?.state === 'public') issues.push('Tailscaleにインターネット公開設定があります。専用ネットワークの設定を確認してください。');
  for (const [path, message] of [
    ['.runtime/tunnel.yaml', 'Dotとの初回接続設定が必要です。導入手順を開いてください。'],
    ['.runtime/models/ggml-small.bin', '音声認識モデルがありません。導入手順を確認してください。'],
    ['dist/index.html', '端末画面が未ビルドです。導入手順を確認してください。'],
  ]) if (!await exists(path)) issues.push(message);
  if (!await executable([resolve('.runtime/bin/whisper-cli'), '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'])) issues.push('音声認識用のwhisper-cliがありません。');
  let bridge = false, subscribed = false, notificationSubscribed = false, device = false, tunnel = false;
  let key;
  try { key = (await readFile('.runtime/device-key', 'utf8')).trim(); } catch {}
  if (key) {
    try {
      const response = await fetch('http://127.0.0.1:3460/api/status', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) });
      if (response.ok) { const state = await response.json(); bridge = true; subscribed = state.subscribed === true; notificationSubscribed = state.notificationSubscribed === true; }
    } catch {}
    if (ts?.state === 'ready') {
      try { device = (await fetch(`${ts.origin}/api/status`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(4000) })).ok; } catch {}
    }
  }
  try { tunnel = (await fetch('http://127.0.0.1:3461/readyz', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  if (!bridge) issues.push('Macの中継が停止しています。「接続設定を自動で整える」で起動できます。');
  else if (!subscribed) issues.push('Dotの音声受信が未接続です。Dot側でG2連携を再開してください。');
  if (!voiceOnly && bridge && !notificationSubscribed) issues.push('Dotの通知受信が未接続です。Dot側で通知連携を再開してください。');
  if (!tunnel) issues.push('Dotへの接続が復帰待ちです。続く場合は接続設定を整えてください。');
  if (ts?.state === 'ready' && !device) issues.push('iPhone用の接続先に到達できません。接続設定を整えてください。');
  return { version: 1, ready: issues.length === 0, origin: ts?.origin, bridge, subscribed, notificationSubscribed, device, tunnel, issues };
}
async function install() {
  await assertOwnedAgents(resolve('.'));
  const ts = await tailscale();
  if (ts.state === 'public' || ts.state === 'conflict') throw new Error('既存のTailscale設定と競合しています。自動変更せず停止しました。');
  const required = ['.runtime/tunnel.yaml', '.runtime/models/ggml-small.bin', 'dist/index.html'];
  if (!voiceOnly) required.push('.runtime/notification-menu/Dot Notification Lab.app/Contents/MacOS/DotNotificationLab');
  for (const path of required)
    if (!await exists(path)) throw new Error('初回導入が未完了です。導入手順を開いて不足項目を確認してください。');
  if (!await executable([resolve('.runtime/bin/tunnel-client'), '/opt/homebrew/bin/tunnel-client', '/usr/local/bin/tunnel-client'])) throw new Error('tunnel-clientを導入してください。');
  await mkdir('.runtime', { recursive: true, mode: 0o700 });
  await run(process.execPath, ['server/init.ts']);
  if (ts.state !== 'ready') {
    try { await runTailscale(ts.bin, ['serve', '--bg', '--https=443', 'http://127.0.0.1:3462']); }
    catch { throw new Error('TailscaleのHTTPSを有効にできません。Tailscale側でHTTPSの許可を確認してください。'); }
  }
  await writeFile('.runtime/device-config.json', JSON.stringify({ version: 1, origin: ts.origin }), { mode: 0o600 });
  const changed = await prepareAgents(resolve('.'), ts.origin, { install: true, menu: !voiceOnly });
  if (!voiceOnly) await run(process.execPath, ['scripts/pair-device.mjs', ts.origin]);
  return { changed, message: '接続先を自動設定し、ログイン時の自動起動を登録しました。' };
}
try {
  const action = process.argv[2] ?? 'status';
  if (action === 'status') await output(await inspect());
  else if (action === 'install') await output(await install());
  else if (action === 'pair') {
    const ts = await tailscale();
    if (ts.state !== 'ready') throw new Error('先に接続設定を自動で整えてください。');
    await run(process.execPath, ['scripts/pair-device.mjs', ts.origin]);
    await output({ ready: true });
  } else throw new Error('不明な操作です。');
} catch (error) {
  const message = error.code || error.stdout !== undefined ? '設定を完了できませんでした。接続と導入手順を確認してください。' : error.message;
  await output({ ready: false, issues: [message] }); process.exitCode = 1;
}
