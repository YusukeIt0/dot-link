// In-process notifications: idle clients do not poll the disk or the bridge.
export class ChangeSignal {
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  emit(): void { for (const listener of [...this.listeners]) listener(); }
}
