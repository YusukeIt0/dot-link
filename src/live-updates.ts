export interface Revisioned { revision: string; }

/** One cancellable request at a time. Reconnects without accepting stale replies. */
export class LiveUpdates<T extends Revisioned> {
  private controller?: AbortController;
  private initialPending = true;
  private connected = false;
  private failureAt?: number;
  private failureTimer?: ReturnType<typeof setTimeout>;
  private failureShown = false;
  private recoveryGraceMs: number;
  private fetchUpdate: (revision: string | undefined, signal: AbortSignal) => Promise<T>;
  private receive: (value: T, initial: boolean) => void;
  private failed: () => void;
  constructor(fetchUpdate: (revision: string | undefined, signal: AbortSignal) => Promise<T>, receive: (value: T, initial: boolean) => void, failed: () => void, recoveryGraceMs = 2000) {
    this.recoveryGraceMs = recoveryGraceMs;
    this.fetchUpdate = fetchUpdate; this.receive = receive; this.failed = failed;
  }
  private cancel(): void {
    this.controller?.abort(); this.controller = undefined;
    clearTimeout(this.failureTimer); this.failureTimer = undefined;
  }
  stop(): void { this.cancel(); this.clearFailure(); this.connected = false; }
  private clearFailure(): void {
    clearTimeout(this.failureTimer); this.failureTimer = undefined;
    this.failureAt = undefined; this.failureShown = false;
  }
  private revealFailure(signal: AbortSignal): void {
    if (signal.aborted || this.failureShown) return;
    const remaining = this.connected ? Math.max(0, this.failureAt! + this.recoveryGraceMs - Date.now()) : 0;
    if (remaining) {
      if (this.failureTimer === undefined) this.failureTimer = setTimeout(() => {
        this.failureTimer = undefined; this.revealFailure(signal);
      }, remaining);
    } else { this.failureShown = true; this.failed(); }
  }
  start(initial = false, revision?: string): void {
    // A foreground/network restart must not turn an unfinished history restore
    // into 100 new replies. A supplied revision follows an externally applied snapshot.
    if (initial) { this.initialPending = true; this.connected = false; this.clearFailure(); }
    else if (revision !== undefined) this.initialPending = false;
    this.cancel(); const controller = new AbortController(); this.controller = controller;
    if (this.failureAt !== undefined) this.revealFailure(controller.signal);
    void this.run(controller.signal, revision);
  }
  private async run(signal: AbortSignal, revision?: string): Promise<void> {
    let retryMs = 1000;
    while (!signal.aborted) {
      try {
        const update = await this.fetchUpdate(revision, signal);
        if (signal.aborted) return;
        this.clearFailure(); this.connected = true;
        this.receive(update, this.initialPending);
        if (signal.aborted) return;
        this.initialPending = false; revision = update.revision; retryMs = 1000;
      } catch {
        if (signal.aborted) return;
        this.failureAt ??= Date.now(); this.revealFailure(signal); revision = undefined;
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, retryMs); signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
        retryMs = Math.min(retryMs * 2, 10000);
      }
    }
  }
}
