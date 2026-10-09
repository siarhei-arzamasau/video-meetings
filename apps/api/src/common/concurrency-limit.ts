/**
 * Lets at most `limit` pieces of work run at once; the rest wait their turn, first come first
 * served.
 *
 * In this process and no further: a second replica has a limit of its own. It is for work
 * that holds something scarce for as long as it runs — a pooled database connection, above
 * all — where an unbounded number of them would leave none for anything else.
 */
export class ConcurrencyLimit {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  /** Runs `work` once a place is free, and frees the place however `work` ends. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();

    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;

      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  /** Hands the place straight to whoever has waited longest, so nobody can jump the queue. */
  private release(): void {
    const next = this.waiting.shift();

    if (next === undefined) {
      this.available += 1;
    } else {
      next();
    }
  }
}
