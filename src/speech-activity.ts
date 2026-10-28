/** Shared with wake endpointing; this detects speech, not a speaker's identity. */
// Presence checking permits brief acknowledgements; wake endpointing keeps its
// existing 300 ms rule. Neither policy depends on locale or recognized text.
export function speechActivityConfig(model: string, purpose: 'endpoint' | 'presence' = 'endpoint') {
  return {
    sileroVad: { model, threshold: 0.5, minSilenceDuration: 1.2,
      minSpeechDuration: purpose === 'presence' ? 0.064 : 0.3, maxSpeechDuration: 30, windowSize: 512 },
    sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 32,
  };
}

export interface ClipSpeechDetector {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  reset(): void;
  flush(): void;
}

/** Scan the complete recording without trimming quiet speech or pauses. */
export function recordingHasSpeech(wav: Uint8Array, detector: ClipSpeechDetector): boolean {
  const pcm = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44);
  // Normalize only the detector input. A quiet short answer must not need a
  // language-specific loudness threshold; the original WAV stays untouched.
  let peak = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) peak = Math.max(peak, Math.abs(pcm.getInt16(offset, true)));
  // Bound amplification so near-zero quantization noise is not raised to full scale.
  const scale = peak > 0 ? Math.min(0.9 / peak, 128 / 32768) : 1 / 32768;
  detector.reset();
  try {
    for (let offset = 0; offset < pcm.byteLength; offset += 1024) {
      const frame = new Float32Array(512);
      for (let i = 0; i < 512 && offset + i * 2 < pcm.byteLength; i++) {
        frame[i] = pcm.getInt16(offset + i * 2, true) * scale;
      }
      detector.acceptWaveform(frame);
      if (detector.isDetected() || !detector.isEmpty()) return true;
    }
    // A recording may end during speech rather than after the endpoint silence.
    detector.flush();
    return !detector.isEmpty();
  } finally { detector.reset(); }
}
