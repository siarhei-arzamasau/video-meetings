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
  leases: LeaseRenewer;
  logger: Logger;
  /** The row the claim is on: what `renewLease` is asked about. */
  claimId: string;
  /** What was claimed, as a log line opens: `File <id> of meeting <id>`. */
  subject: string;
  /** The lease the claim was given. `null` disables renewal, as a lost one does. */
  lease: Date | null;
  leaseSeconds: number;
  /**
   * Called once, the moment a renewal finds the row is no longer ours. For a caller whose
   * work is a request to something outside the process: without it a transcription whose file
   * was deleted would run on for minutes to produce a result that is already discarded.
   */
  onLost?: () => void;
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
export function startLeaseHeartbeat(options: LeaseHeartbeatOptions): LeaseHeartbeat {
  const everyMs = Math.max(1_000, Math.floor((options.leaseSeconds / 3) * 1_000));
  const renewal = new LeaseRenewal(options);
  let inFlight: Promise<void> | undefined;

  const timer = setInterval(() => {
    if (inFlight === undefined) {
      inFlight = renewal.renew().finally(() => {
        inFlight = undefined;
      });
    }
  }, everyMs);
  timer.unref();

  return {
    stop: async () => {
      renewal.halt();
      clearInterval(timer);
      await inFlight;

      return renewal.lease;
    },
  };
}

/**
 * One claim's lease as its heartbeat knows it: the value the row holds, and the one renewal
 * that replaces it. The timer above decides when a renewal runs and that two never overlap;
 * this decides what one does.
 */
class LeaseRenewal {
  private current: Date | null;
  private running = true;

  constructor(private readonly options: LeaseHeartbeatOptions) {
    this.current = options.lease;
  }

  /** The lease the row holds now — `null` once a renewal found the claim gone. */
  get lease(): Date | null {
    return this.current;
  }

  /** No renewal starts after this; one already in flight still finishes. */
  halt(): void {
    this.running = false;
  }

  async renew(): Promise<void> {
    const { leases, logger, claimId, subject, leaseSeconds, onLost } = this.options;

    if (!this.running || this.current === null) {
      return;
    }

    try {
      const renewed = await leases.renewLease(claimId, this.current, leaseSeconds);

      if (renewed === null) {
        // Deleted, or reclaimed after an expiry this heartbeat did not prevent. Stop
        // renewing; the result will be discarded when the step finishes.
        logger.warn(`${subject}: lease lost mid-run`);
        this.current = null;
        onLost?.();

        return;
      }

      this.current = renewed;
    } catch (error) {
      // A failed renewal is not a lost lease: the next beat tries again, and the transition
      // at the end is the real check.
      logger.error(
        `${subject}: renewing the lease failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
