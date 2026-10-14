/** One physical microphone shared by hold-to-talk and optional wake listening. */
export class MicrophoneLease {
  private capture = false;
  private listening = false;
  private open = false;
  private operation = Promise.resolve(true);
  private control: (open: boolean) => Promise<boolean>;
  constructor(control: (open: boolean) => Promise<boolean>) { this.control = control; }
  setCapture(open: boolean): Promise<boolean> { this.capture = open; return this.reconcile(); }
  setListening(open: boolean): Promise<boolean> { this.listening = open; return this.reconcile(); }
  private reconcile(): Promise<boolean> {
    this.operation = this.operation.catch(() => false).then(async () => {
      const wanted = this.capture || this.listening;
      if (wanted === this.open) return true;
      try {
        if (!await this.control(wanted)) return false;
        this.open = wanted;
        return true;
      } catch { return false; }
    });
    return this.operation;
  }
}
