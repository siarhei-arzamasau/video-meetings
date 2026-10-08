/**
 * The keys a browser spec is holding, and the generations waiting on them.
 *
 * **A generation is held only while a spec holds its key**, which is the fake transcriber's
 * rule for the same reason: the specs share one database and the API generates one digest at
 * a time, so a hold that outlived its test would stop every digest after it. A key nobody
 * holds — never registered, released, or forgotten by `releaseAll` at a test's end — holds
 * nothing, so a meeting another test left behind is answered at once whatever its transcript
 * says.
 */
export class DigestHolds {
  private readonly held = new Set<string>();
  private readonly waiting = new Set<() => void>();

  hold(key: string): void {
    this.held.add(key);
  }

  release(key: string): void {
    this.held.delete(key);
    this.wake();
  }

  releaseAll(): void {
    this.held.clear();
    this.wake();
  }

  /**
   * Resolves once none of `keys` is held — at once, when none is — and rejects with the
   * signal's reason if the caller hangs up first.
   */
  released(keys: ReadonlyArray<string>, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (signal.aborted) {
          this.waiting.delete(check);
          reject(signal.reason instanceof Error ? signal.reason : new Error('Hung up'));
        } else if (!keys.some((key) => this.held.has(key))) {
          this.waiting.delete(check);
          signal.removeEventListener('abort', check);
          resolve();
        }
      };

      this.waiting.add(check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }

  private wake(): void {
    for (const check of this.waiting) {
      check();
    }
  }
}
