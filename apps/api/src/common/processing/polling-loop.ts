import type { Logger } from '@nestjs/common';

/**
 * Calls `tick` until it reports there was nothing to do, then waits `pollMs` and asks again.
 * It knows nothing about what a tick does, which is the point: the worker's scheduling and
 * shutdown mechanics are the same whatever kind of row is being claimed.
 *
 * A tick that throws is logged and the loop carries on — a claim that fails on a lost
 * connection must not end the polling for the life of the process.
 */
export class PollingLoop {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly tick: () => Promise<boolean>,
    private readonly pollMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.schedule(0);
  }

  /**
   * Stops scheduling and waits for the tick in flight, so a shutdown never abandons a claim.
   * Whatever should make that tick let go early — an abort signal the steps honour — has to
   * be triggered by the caller before this is awaited.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.inFlight = this.tick()
        .then((handled) => {
          this.schedule(handled ? 0 : this.pollMs);
        })
        .catch((error: unknown) => {
          // A claim that throws (a lost connection, say) must not kill the loop.
          this.logger.error(
            'Worker tick failed',
            error instanceof Error ? error.stack : String(error),
          );
          this.schedule(this.pollMs);
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, delayMs);
  }
}
