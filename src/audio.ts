import { t } from './i18n.ts';
export const SAMPLE_RATE = 16_000;
export const MAX_RECORDING_SECONDS = 30;

// Even Hub supplies mono signed 16-bit little-endian PCM at 16 kHz.
export class PcmRecording {
  private chunks: Uint8Array[] = [];
  byteLength = 0;
  readonly maxBytes: number;

  constructor(seconds = MAX_RECORDING_SECONDS) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid duration');
    this.maxBytes = Math.floor(seconds * SAMPLE_RATE) * 2;
  }

  append(frame: Uint8Array): boolean {
    if (frame.byteLength % 2) throw new Error('PCM frame must contain complete 16-bit samples');
    const available = this.maxBytes - this.byteLength;
    const size = Math.min(available, frame.byteLength);
    if (size > 0) {
      this.chunks.push(frame.slice(0, size)); // The SDK may reuse its input buffer.
      this.byteLength += size;
    }
    return this.byteLength < this.maxBytes;
  }

  get duration(): number { return this.byteLength / (SAMPLE_RATE * 2); }

  clear(): void { this.chunks = []; this.byteLength = 0; }

  toWav(): Uint8Array {
    const result = new Uint8Array(44 + this.byteLength);
    const view = new DataView(result.buffer);
    const label = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) result[offset + i] = value.charCodeAt(i);
    };
    label(0, 'RIFF'); view.setUint32(4, 36 + this.byteLength, true);
    label(8, 'WAVE'); label(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    label(36, 'data'); view.setUint32(40, this.byteLength, true);
    let offset = 44;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
}

export type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping' | 'stop-error';

export class Recorder {
  state: RecordingState = 'idle';
  private wanted = false;
  private timer?: ReturnType<typeof setTimeout>;
  private buffer = new PcmRecording();
  private operation: Promise<void> = Promise.resolve();
  private microphone: (open: boolean) => Promise<boolean>;
  private onClip: (wav: Uint8Array, seconds: number) => void;
  private onState: (state: RecordingState) => void;
  private onError: (message: string) => void;
  constructor(
    microphone: (open: boolean) => Promise<boolean>,
    onClip: (wav: Uint8Array, seconds: number) => void,
    onState: (state: RecordingState) => void,
    onError: (message: string) => void,
  ) { this.microphone = microphone; this.onClip = onClip; this.onState = onState; this.onError = onError; }
  private setState(state: RecordingState): void { this.state = state; this.onState(state); }
  private queue(action: () => Promise<void>): Promise<void> {
    this.operation = this.operation.then(action).catch(error => {
      this.onError(error instanceof Error ? error.message : t('マイク操作に失敗しました'));
    });
    return this.operation;
  }
  start(): Promise<void> {
    if (this.wanted || this.state !== 'idle') return this.operation;
    this.wanted = true;
    this.buffer.clear();
    this.setState('starting');
    return this.queue(async () => {
      try {
        if (!await this.microphone(true)) throw new Error(t('G2のマイクを開始できませんでした'));
        this.setState('recording');
        this.timer = setTimeout(() => void this.stop(), MAX_RECORDING_SECONDS * 1000);
      } catch (error) {
        this.wanted = false;
        this.buffer.clear();
        this.setState('idle');
        throw error;
      }
    });
  }
  stop(discard = false): Promise<void> {
    this.wanted = false;
    if (this.state === 'idle') return this.operation;
    return this.queue(async () => {
      if (this.state === 'idle') return;
      clearTimeout(this.timer);
      this.setState('stopping');
      let stopped = false;
      try {
        if (!await this.microphone(false)) throw new Error(t('マイク停止を確認できません。Evenアプリで停止してください'));
        stopped = true;
        if (!discard && this.buffer.byteLength) this.onClip(this.buffer.toWav(), this.buffer.duration);
      } finally {
        this.buffer.clear();
        this.setState(stopped ? 'idle' : 'stop-error');
      }
    });
  }
  append(frame: Uint8Array): void {
    if (!this.wanted || (this.state !== 'recording' && this.state !== 'starting')) return;
    try { if (!this.buffer.append(frame)) void this.stop(); }
    catch (error) { this.onError((error as Error).message); void this.stop(true); }
  }
}
