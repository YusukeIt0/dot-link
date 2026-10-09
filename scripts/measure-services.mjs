// Read-only process sample. No command lines, environment, keys or messages.
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

if (process.platform !== 'darwin') throw new Error('macOS is required');
const names = ['bridge', 'device', 'tunnel', 'menu'];
const samples = [];
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
const cpuSeconds = value => {
  const parts = value.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};
for (let index = 0; index < 6; index++) {
  const sample = { at: new Date().toISOString(), services: {} };
  for (const name of names) {
    try {
      const job = run('/bin/launchctl', ['print', `gui/${process.getuid()}/local.even-g2-dot.${name}`]);
      const pid = /^\s*pid = (\d+)\s*$/m.exec(job)?.[1];
      if (!pid) { sample.services[name] = { running: false }; continue; }
      const [percent, rss, time] = run('/bin/ps', ['-p', pid, '-o', '%cpu=', '-o', 'rss=', '-o', 'time=']).trim().split(/\s+/);
      if (![Number(percent), Number(rss), cpuSeconds(time)].every(Number.isFinite)) throw new Error('Incomplete sample');
      sample.services[name] = { pid: Number(pid), psCpuPercent: Number(percent), rssKiB: Number(rss), cpuSeconds: cpuSeconds(time) };
    } catch { sample.services[name] = { available: false }; }
  }
  samples.push(sample);
  if (index < 5) await setTimeout(5000);
}
const first = samples[0], last = samples.at(-1);
const durationSeconds = (Date.parse(last.at) - Date.parse(first.at)) / 1000;
const summary = {};
for (const name of names) {
  const values = samples.map(sample => sample.services[name]);
  if (!values.every(value => value.pid && value.pid === values[0].pid)) {
    summary[name] = { continuous: false }; continue;
  }
  const delta = values.at(-1).cpuSeconds - values[0].cpuSeconds;
  summary[name] = {
    continuous: true,
    meanCpuPercentOneCore: Math.round(delta / durationSeconds * 10000) / 100,
    rssMiBMin: Math.min(...values.map(value => value.rssKiB)) / 1024,
    rssMiBMax: Math.max(...values.map(value => value.rssKiB)) / 1024,
  };
}
console.log(JSON.stringify({ scope: 'Ambient observation; user activity and transcription children are not measured', durationSeconds, summary, samples }, null, 2));
