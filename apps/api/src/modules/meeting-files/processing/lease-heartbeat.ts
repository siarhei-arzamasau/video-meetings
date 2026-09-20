import type { Logger } from '@nestjs/common';

/** The one repository call a heartbeat makes, so a spec can drive it with a stub. */
export interface LeaseRenewer {
  renewLease(id: string, lease: Date | null, leaseSeconds: number): Promise<Date | null>;
}

export interface LeaseHeartbeat {
  /** Stops renewing and hands back the lease the row holds — `null` once it was lost. */
  stop(): Promise<Date | null>;
}

export interface LeaseHeartbeatOptions {
  files: LeaseRenewer;
  logger: Logger;
  fileId: string;
  meetingId: string;
  /** The lease the claim was given. `null` disables renewal, as a lost one does. */
  lease: Date | null;
  leaseSeconds: number;
}

/**
 * Extends a claim's lease every `lease / 3` seconds until `stop()` is called, and hands back
 * the lease the row actually holds — `null` once a renewal has found the row is no longer
 * ours, which makes the caller's conditional update miss and its result be discarded.
 *
 * One renewal at a time, and `stop()` waits for the one in flight. Both guard the same thing:
 * each renewal is conditional on the lease the previous one set, so a renewal that overlaps a
 * slow one — or a `stop()` that returns while one is still committing — would hand the caller
 * a lease the database has already replaced, and the worker would discard its own result as a
 * lost race.
 *
 * A third of the lease, so two renewals may be lost before it expires. The timer is `unref`ed:
 * a heartbeat must never be the reason the process stays alive.
 */
export function startLeaseHeartbeat({
  files,
  logger,
  fileId,
  meetingId,
  lease,
  leaseSeconds,
}: LeaseHeartbeatOptions): LeaseHeartbeat {
  const everyMs = Math.max(1_000, Math.floor((leaseSeconds / 3) * 1_000));
  let current = lease;
  let running = true;
  let inFlight: Promise<void> | undefined;

  const beat = async (): Promise<void> => {
    if (!running || current === null) {
      return;
    }

    try {
      const renewed = await files.renewLease(fileId, current, leaseSeconds);

      if (renewed === null) {
        // Deleted, or reclaimed after an expiry this heartbeat did not prevent. Stop
        // renewing; the result will be discarded when the step finishes.
        logger.warn(`File ${fileId} of meeting ${meetingId}: lease lost while processing`);
        current = null;

        return;
      }

      current = renewed;
    } catch (error) {
      // A failed renewal is not a lost lease: the next beat tries again, and the transition
      // at the end is the real check.
      logger.error(
        `File ${fileId}: renewing the lease failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  };

  const timer = setInterval(() => {
    if (inFlight === undefined) {
      inFlight = beat().finally(() => {
        inFlight = undefined;
      });
    }
  }, everyMs);
  timer.unref();

  return {
    stop: async () => {
      running = false;
      clearInterval(timer);
      await inFlight;

      return current;
    },
  };
}
