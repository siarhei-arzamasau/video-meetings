import { Injectable, OnModuleDestroy } from '@nestjs/common';

/** The string token this is also registered under, so an e2e spec can reach `settled()`. */
export const PENDING_DIGEST_REQUESTS = 'PENDING_DIGEST_REQUESTS';

/**
 * The writes to a digest that a file's event started and nothing awaits: the request a
 * transcribed recording makes, and what a deleted one does to the digest built from it —
 * each with the announcement that follows it.
 *
 * Both are made from an event handler, and the `EventBus` does not wait for one: the
 * publisher — the transcription worker, the delete route — has moved on before the write
 * is made. Two things need to know when it has been:
 *
 * - **shutdown**, which must not close the database connection under a write in flight —
 *   `onModuleDestroy` here runs before `PrismaService`'s, which Nest runs last;
 * - **`MeetingDigestWorker.drain()`**, the tests' handle, which would otherwise look for
 *   work a moment before the request that makes it exists.
 *
 * In-process, like the bus it follows. Nothing in production orders anything by it. Named
 * for the first of the two, which was the only one when it was written.
 */
@Injectable()
export class PendingDigestRequests implements OnModuleDestroy {
  private readonly pending = new Set<Promise<void>>();

  /** Registers a write that is already under way. It must not reject: its caller logs. */
  track(request: Promise<void>): void {
    this.pending.add(request);
    void request.finally(() => this.pending.delete(request));
  }

  /** Resolves once none is in flight, those started while this waited included. */
  async settled(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }

    await Promise.allSettled(this.pending);

    return this.settled();
  }

  onModuleDestroy(): Promise<void> {
    return this.settled();
  }
}
