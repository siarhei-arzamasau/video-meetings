import { Injectable } from '@nestjs/common';

/**
 * Keeps a worker's claim from being announced before the write that handed it the row.
 *
 * A hand-over is a write that makes a row claimable: an upload, either retry, and the file
 * worker's `ready`, which is what queues a recording. The claim that follows is announced by
 * a different actor, each of them when its own write returns, and Node does not always resume
 * the two in the order PostgreSQL committed them. Measured with the retry handler against the
 * transcription worker, "transcribing" was announced before "queued" in 8 of 3,200 runs — and
 * a subscriber replaces a row by id, so the page kept "Queued" under a running transcription
 * until its next full list.
 *
 * So a hand-over runs as one step here — its write and, synchronously after it, its
 * announcement — and a worker asks `announced` before it announces a claim. **That is enough
 * because of what a claim proves.** A row is claimable only once its hand-over has committed,
 * and the hand-over was registered here before its write was sent. When a claim comes back,
 * every hand-over of that file is therefore either finished, and announced, or still in the map.
 *
 * **Only claims wait, and only for hand-overs.** Two writes that do not depend on each other —
 * a delete beside a retry — commit in an order nothing in this process can know, and making
 * one wait for the other would misorder them as often as not.
 *
 * **In-process, like the fan-out it protects.** It holds for one API instance, which is all
 * `MeetingFileEventsService` serves. `LISTEN/NOTIFY` issued inside the writing transaction
 * would replace it, since PostgreSQL delivers notifications in commit order.
 */
@Injectable()
export class MeetingFileHandOvers {
  /** File id → every hand-over of that file still between its write and its announcement. */
  private readonly inFlight = new Map<string, Promise<void>>();

  /**
   * Runs one hand-over. `step` sends the write and announces it before it resolves, and it is
   * called at once: the step is registered before its write can have reached the database.
   */
  run<T>(fileId: string, step: () => Promise<T>): Promise<T> {
    const result = step();
    const settled: Promise<void> = Promise.allSettled([this.inFlight.get(fileId), result]).then(
      () => {
        // Still the last one registered, so nothing is in flight for the file any more.
        if (this.inFlight.get(fileId) === settled) {
          this.inFlight.delete(fileId);
        }
      },
    );

    this.inFlight.set(fileId, settled);

    return result;
  }

  /**
   * Resolves once every hand-over in flight for the file right now has announced — or failed
   * to: a write that matched no row announces nothing, and there is nothing left to wait for.
   */
  announced(fileId: string): Promise<void> {
    return this.inFlight.get(fileId) ?? Promise.resolve();
  }
}
