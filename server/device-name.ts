import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname, platform } from 'node:os';

export function cleanDeviceName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
}
export async function deviceName(): Promise<string> {
  if (platform() === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 1000, maxBuffer: 4096 });
      const name = cleanDeviceName(stdout);
      if (name) return name;
    } catch {}
  }
  return cleanDeviceName(hostname()) || '接続先';
}
