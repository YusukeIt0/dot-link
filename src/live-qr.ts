import jsQR from 'jsqr';

export type CameraIssue = 'unavailable' | 'denied' | 'failed' | 'timeout' | 'playback';
export type CameraStage = 'request' | 'acquired' | 'playback' | 'scanning' | 'decode';
export interface CameraEvidence { stage: CameraStage; error?: string; }
type FrameReader = (video: HTMLVideoElement) => string | undefined;

/** Camera frames stay in memory. No audio track, image upload or recording. */
export class LiveQrScanner {
  private video: HTMLVideoElement;
  private devices: Pick<MediaDevices, 'getUserMedia'> | undefined;
  private canvas?: HTMLCanvasElement;
  private readFrame: FrameReader;
  private stream?: MediaStream;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private lastValue?: string;
  private resumePlayback?: () => Promise<void>;

  async resume(): Promise<void> { await this.resumePlayback?.(); }

  constructor(video: HTMLVideoElement, devices: Pick<MediaDevices, 'getUserMedia'> | undefined = navigator.mediaDevices, readFrame?: FrameReader) {
    this.video = video; this.devices = devices;
    this.readFrame = readFrame ?? (view => this.decode(view));
  }

  stop(): void {
    this.generation++;
    clearTimeout(this.timer); clearTimeout(this.deadline);
    this.timer = undefined; this.deadline = undefined;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = undefined; this.lastValue = undefined; this.resumePlayback = undefined;
    this.video.pause(); this.video.srcObject = null;
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.canvas = undefined;
  }

  async start(accept: (raw: string) => boolean, issue: (reason: CameraIssue) => void,
    evidence: (value: CameraEvidence) => void = () => {}): Promise<void> {
    this.stop();
    const generation = this.generation;
    const current = () => generation === this.generation;
    const report = (stage: CameraStage, error?: unknown) => evidence({ stage,
      ...(error ? { error: error instanceof Error && /^[A-Za-z]{1,48}$/.test(error.name) ? error.name : 'UnknownError' } : {}),
    });
    const fail = (reason: CameraIssue) => { if (current()) { this.stop(); issue(reason); } };
    report('request');
    if (!this.devices?.getUserMedia) { fail('unavailable'); return; }
    // A permission prompt can remain pending. Late approval must not revive a closed scanner.
    this.deadline = setTimeout(() => fail('timeout'), 90000);
    let stream: MediaStream;
    try {
      // No await before this call: preserve the button's user gesture.
      // Acquire with the smallest request first. WKWebView may reject camera
      // selection constraints with NotAllowedError before returning a stream.
      stream = await this.devices.getUserMedia({ audio: false, video: true });
    } catch (error) {
      if (!current()) return;
      report('request', error);
      fail(error instanceof Error && ['NotAllowedError', 'SecurityError'].includes(error.name) ? 'denied' : 'failed');
      return;
    }
    if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    report('acquired');
    // Prefer the rear camera only after access succeeds. Unsupported selection
    // must not discard an otherwise usable camera or trigger another permission request.
    const track = stream.getVideoTracks?.()[0];
    if (track?.applyConstraints) {
      try { await track.applyConstraints({ facingMode: { ideal: 'environment' } }); }
      catch { /* Keep the acquired camera if rear-camera selection is unavailable. */ }
      if (!current()) return;
    }
    this.video.muted = true; this.video.playsInline = true; this.video.srcObject = stream;
    const tick = () => {
      if (!current()) return;
      try {
        const value = this.readFrame(this.video);
        if (value && value !== this.lastValue) {
          this.lastValue = value;
          if (accept(value)) { if (current()) this.stop(); return; }
        }
      } catch (error) { report('decode', error); fail('failed'); return; }
      if (current()) this.timer = setTimeout(tick, 200);
    };
    let playing = false;
    const play = async () => {
      if (!current() || playing) return;
      playing = true;
      report('playback');
      try { await this.video.play(); }
      catch (error) {
        playing = false;
        if (!current()) return;
        report('playback', error);
        // Camera access already succeeded. A new tap can satisfy a playback gesture restriction.
        if (error instanceof Error && error.name === 'NotAllowedError') { issue('playback'); return; }
        fail('failed'); return;
      }
      if (!current()) return;
      this.resumePlayback = undefined;
      report('scanning'); tick();
    };
    this.resumePlayback = play;
    await play();
  }

  private decode(video: HTMLVideoElement): string | undefined {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    this.canvas ??= document.createElement('canvas');
    const canvas = this.canvas;
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    try {
      const result = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
      return result && result.data.length <= 1024 ? result.data : undefined;
    } finally { frame.data.fill(0); context.clearRect(0, 0, canvas.width, canvas.height); }
  }
}
