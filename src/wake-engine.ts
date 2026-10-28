import { MAX_RECORDING_SECONDS, PcmRecording, SAMPLE_RATE } from './audio.ts';

export type SpeakerRole = 'self' | 'other' | 'unknown';

export interface KeywordStream {
  acceptWaveform(rate: number, samples: Float32Array): void;
  free(): void;
}
export interface KeywordSpotter {
  createStream(): KeywordStream;
  isReady(stream: KeywordStream): boolean;
  decode(stream: KeywordStream): void;
  getResult(stream: KeywordStream): { keyword?: string; start_time?: number; timestamps?: number[] };
  free(): void;
}
export interface SpeechDetector {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  reset(): void;
  free(): void;
}
export type WakeEvent = { type: 'wake' } | { type: 'clip'; wav?: Uint8Array; seconds: number };

/** A bounded, phone-local audio path. Only a post-wake utterance can leave it. */
export class WakeEngine {
  private kws: KeywordSpotter;
  private vad: SpeechDetector;
  private event: (event: WakeEvent) => void;
  private stream?: KeywordStream;
  private mode: 'idle' | 'listening' | 'capture' = 'idle';
  private ring = new Int16Array(SAMPLE_RATE * 2);
  private received = 0;
  private roles = new Uint8Array(SAMPLE_RATE * 2);
  private clip = new PcmRecording();
  private speechSeen = false;
  private held = false;
  private vadFrame = new Float32Array(512);
  private vadUsed = 0;

  constructor(kws: KeywordSpotter, vad: SpeechDetector, event: (event: WakeEvent) => void) {
    this.kws = kws; this.vad = vad; this.event = event;
  }
  listen(): void {
    this.cancel();
    this.stream = this.kws.createStream();
    this.mode = 'listening';
  }
  cancel(): void {
    this.mode = 'idle';
    this.stream?.free(); this.stream = undefined;
    this.ring.fill(0); this.roles.fill(0); this.received = 0;
    this.clip.clear(); this.speechSeen = false; this.held = false;
    this.vad.reset(); this.vadFrame.fill(0); this.vadUsed = 0;
  }
  /** A long press takes over an active utterance without throwing it away. */
  hold(): void { if (this.mode === 'capture') this.held = true; }
  finish(discard = false): void {
    if (this.mode !== 'capture') return;
    const deliver = !discard && (this.speechSeen || this.held) && this.clip.byteLength > 0;
    const event: WakeEvent = { type: 'clip', seconds: this.clip.duration,
      ...(deliver ? { wav: this.clip.toWav() } : {}) };
    this.cancel();
    this.event(event);
  }
  dispose(): void { this.cancel(); this.kws.free(); this.vad.free(); }

  append(pcm: Uint8Array, role: SpeakerRole = 'unknown'): void {
    if (pcm.byteLength % 2 || pcm.byteLength > SAMPLE_RATE * 2) throw new Error('Invalid audio frame');
    if (this.mode === 'idle') return;
    const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    // Small slices keep timestamps and endpoint decisions independent of host framing.
    for (let offset = 0; offset < pcm.length && this.active; offset += 640) {
      const bytes = pcm.subarray(offset, Math.min(offset + 640, pcm.length));
      const samples = new Float32Array(bytes.length / 2);
      for (let i = 0; i < samples.length; i++) {
        const value = input.getInt16(offset + i * 2, true);
        samples[i] = value / 32768;
        const index = this.received++ % this.ring.length;
        this.ring[index] = value;
        this.roles[index] = this.mode === 'listening' && role === 'other' ? 1 : 0;
      }
      if (this.mode === 'capture') { this.capture(bytes, samples); continue; }
      const stream = this.stream!;
      stream.acceptWaveform(SAMPLE_RATE, samples);
      while (this.mode === 'listening' && this.kws.isReady(stream)) {
        this.kws.decode(stream);
        const result = this.kws.getResult(stream);
        if (result.keyword !== 'HEY_DOT') continue;
        const last = result.timestamps?.at(-1);
        if (last === undefined || !Number.isFinite(last) || !Number.isFinite(result.start_time ?? 0)) continue;
        // Token timestamps mark onset, not word completion. Keep a short post-token
        // margin; retain following speech already received during decoder latency.
        const end = Math.round(((result.start_time ?? 0) + last + 0.20) * SAMPLE_RATE);
        // Suppress only an entirely observed cue classified as other. Missing,
        // mixed, stale or invalid metadata preserves existing activation.
        const first = result.timestamps?.[0];
        const cueStart = Math.floor(((result.start_time ?? 0) + (first ?? NaN)) * SAMPLE_RATE);
        if (this.otherCue(cueStart, end)) continue;
        // Never substitute the whole ring for an old/future timestamp: it could include pre-wake speech.
        const start = end >= Math.max(0, this.received - this.ring.length) && end <= this.received ? end : this.received;
        const preRoll = new Uint8Array((this.received - start) * 2);
        const view = new DataView(preRoll.buffer);
        const floats = new Float32Array(preRoll.length / 2);
        for (let i = 0; i < floats.length; i++) {
          const value = this.ring[(start + i) % this.ring.length];
          view.setInt16(i * 2, value, true); floats[i] = value / 32768;
        }
        this.mode = 'capture'; this.stream?.free(); this.stream = undefined;
        this.ring.fill(0); this.roles.fill(0); this.vad.reset();
        this.event({ type: 'wake' });
        this.capture(preRoll, floats);
      }
    }
  }
  private otherCue(start: number, end: number): boolean {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < Math.max(0, this.received - this.roles.length)
      || end > this.received || end <= start) return false;
    for (let sample = start; sample < end; sample++) {
      if (this.roles[sample % this.roles.length] !== 1) return false;
    }
    return true;
  }
  private get active(): boolean { return this.mode !== 'idle'; }
  private capture(pcm: Uint8Array, samples: Float32Array): void {
    if (this.mode !== 'capture') return;
    const remaining = this.clip.append(pcm);
    for (const sample of samples) {
      this.vadFrame[this.vadUsed++] = sample;
      if (this.vadUsed !== this.vadFrame.length) continue;
      this.vad.acceptWaveform(this.vadFrame); this.vadUsed = 0;
      if (this.vad.isDetected() || !this.vad.isEmpty()) this.speechSeen = true;
      if (!this.held && !this.vad.isEmpty()) { this.finish(); return; }
    }
    if (!remaining || this.clip.duration >= MAX_RECORDING_SECONDS) this.finish();
    else if (!this.held && !this.speechSeen && this.clip.duration >= 6) this.finish(true);
  }
}
