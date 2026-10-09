export interface Revisioned { revision: string; }

/** One cancellable request at a time. Reconnects without accepting stale replies. */
export class LiveUpdates<T extends Revisioned> {
  private controller?: AbortController;
  private fetchUpdate: (revision: string | undefined, signal: AbortSignal) => Promise<T>;
  private receive: (value: T, initial: boolean) => void;
  private failed: () => void;
  constructor(fetchUpdate: (revision: string | undefined, signal: AbortSignal) => Promise<T>, receive: (value: T, initial: boolean) => void, failed: () => void) {
    this.fetchUpdate = fetchUpdate; this.receive = receive; this.failed = failed;
  }
  stop(): void { this.controller?.abort(); this.controller = undefined; }
  start(initial = false, revision?: string): void {
    this.stop(); const controller = new AbortController(); this.controller = controller;
    void this.run(controller.signal, initial, revision);
  }
  private async run(signal: AbortSignal, initial: boolean, revision?: string): Promise<void> {
    let retryMs = 1000;
    while (!signal.aborted) {
      try {
        const update = await this.fetchUpdate(revision, signal);
        if (signal.aborted) return;
        this.receive(update, initial); initial = false; revision = update.revision; retryMs = 1000;
      } catch {
        if (signal.aborted) return;
        this.failed(); revision = undefined;
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
