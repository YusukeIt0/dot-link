interface NativeStore {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

/** Stops dispatching shared native effects after another runtime takes ownership.
 * Already-dispatched SDK calls cannot be cancelled; callers must also reject
 * their late continuations. Normal explicit exit keeps native cleanup enabled.
 */
export class RuntimeNative {
  private retired = false;
  retire(): void { this.retired = true; }
  get active(): boolean { return !this.retired; }
  control(operation: () => Promise<boolean>): Promise<boolean> {
    // Local cleanup can finish without closing a replacement's native resource.
    return this.retired ? Promise.resolve(true) : operation();
  }
  storage(native: NativeStore): NativeStore {
    return {
      getLocalStorage: async key => {
        if (this.retired) return '';
        const value = await native.getLocalStorage(key);
        return this.retired ? '' : value;
      },
      setLocalStorage: (key, value) => this.retired ? Promise.resolve(false) : native.setLocalStorage(key, value),
    };
  }
}
