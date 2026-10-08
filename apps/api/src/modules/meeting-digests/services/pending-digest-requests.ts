import { Injectable, OnModuleDestroy } from '@nestjs/common';

/** The string token this is also registered under, so an e2e spec can reach `settled()`. */
export const PENDING_DIGEST_REQUESTS = 'PENDING_DIGEST_REQUESTS';

/**
 * The requests for a generation that an event started and nothing awaits.
 *
 * A recording that reaches Transcribed asks for its meeting's digest from an event handler,
 * and the `EventBus` does not wait for one: the publisher — the transcription worker — has
 * moved on before the request is written. Two things need to know when it has been:
 *
 * - **shutdown**, which must not close the database connection under a write in flight —
 *   `onModuleDestroy` here runs before `PrismaService`'s, which Nest runs last;
 * - **`MeetingDigestWorker.drain()`**, the tests' handle, which would otherwise look for
 *   work a moment before the request that makes it exists.
 *
 * In-process, like the bus it follows. Nothing in production orders anything by it.
 */
@Injectable()
export class PendingDigestRequests implements OnModuleDestroy {
  private readonly pending = new Set<Promise<void>>();

  /** Registers a request that is already under way. It must not reject: its caller logs. */
  track(request: Promise<void>): void {
    this.pending.add(request);
    void request.finally(() => this.pending.delete(request));
  }

  /** Resolves once no request is in flight, those started while this waited included. */
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
