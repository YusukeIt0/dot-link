import { mkdir, writeFile, rename } from 'node:fs/promises';
import { SecretInput } from './secret-input.mjs';

// Run directly in the Mac mini's terminal. Never accept the key in argv or print it.
if (!process.stdin.isTTY) {
  console.error('Run this command directly in the Mac mini terminal.'); process.exit(1);
}
process.stdin.setRawMode(true);
process.stdout.write('\u001b[?2004hOpenAIのトンネル接続用キーを貼り付けてEnter（入力は表示されません）: ');
process.stdin.resume();
const decoder = new SecretInput();
const restore = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\u001b[?2004l\n'); };
const input = await new Promise(resolve => {
  const onData = data => {
    const result = decoder.push(data.toString('utf8'));
    if (result) { process.stdin.off('data', onData); resolve(result); }
  };
  process.stdin.on('data', onData);
});
restore();
if (input.cancelled) { console.log('保存を中止しました。'); process.exit(1); }
if (input.error) { console.error(input.error); process.exit(1); }
await mkdir('.runtime', { recursive: true, mode: 0o700 });
await writeFile('.runtime/tunnel-api-key.tmp', input.value, { mode: 0o600 });
await rename('.runtime/tunnel-api-key.tmp', '.runtime/tunnel-api-key');
console.log('接続用キーをこのMacの .runtime/ に保存しました。キーの値は表示していません。');
