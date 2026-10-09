import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const execute = promisify(execFile);
export function validateWav(wav: Buffer): void {
  if (wav.length < 44 + 3200 || wav.length > 44 + 960000 ||
      wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
      wav.readUInt32LE(4) !== wav.length - 8 || wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 ||
      wav.readUInt32LE(24) !== 16000 || wav.readUInt32LE(28) !== 32000 ||
      wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 ||
      wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44 || wav.length % 2)
    throw new Error('Invalid 16 kHz mono recording');
  let energy = 0;
  for (let offset = 44; offset < wav.length; offset += 2) energy += wav.readInt16LE(offset) ** 2;
  if (Math.sqrt(energy / ((wav.length - 44) / 2)) < 40) throw new Error('Recording is silent');
}

export function localTranscriber() {
  let busy = false;
  return async (wav: Buffer): Promise<string> => {
    validateWav(wav);
    if (busy) throw new Error('Transcription in progress');
    busy = true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(resolve('.runtime/asr-'));
      const input = join(directory, 'input.wav');
      const output = join(directory, 'result');
      await writeFile(input, wav, { mode: 0o600 });
      const whisper = process.env.G2_WHISPER_PATH ?? [resolve('.runtime/bin/whisper-cli'), '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find(path => existsSync(path));
      if (!whisper) throw new Error('Whisper is not installed');
      await execute(whisper, ['-m', resolve('.runtime/models/ggml-small.bin'),
        '-f', input, '-l', 'auto', '-nt', '-np', '-otxt', '-of', output],
      { timeout: 90000, maxBuffer: 256000 });
      const text = (await readFile(`${output}.txt`, 'utf8')).trim();
      if (!text || text.length > 4000) throw new Error('No usable transcription');
      return text;
    } finally {
      busy = false;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}
