import type { Logger } from '@nestjs/common';
import type { EventBus } from '@nestjs/cqrs';
import type { MeetingFileStatus } from '@repo/shared';
import { MEETING_FILE_PROCESSING_FAILED_MESSAGE } from '@repo/shared';

import { MeetingFileChangedEvent } from '../events/meeting-file-changed.event';
import { toMeetingFile } from '../services/meeting-file.mapper';
import type {
  ClaimedFile,
  MeetingFileRepository,
  TransitionPatch,
} from '../services/meeting-file.repository';
import type { MeetingFileStorage } from '../storage/meeting-file-storage';
import { StepError } from './step';
import type { StepPatch } from './step';
import { StepFailure, patchBefore } from './step-failure';

/**
 * The writing half of the file worker: how a claim ended, put on the row and then announced.
 * Constructed by the worker, as `MeetingFilePurger` is, and the counterpart of the
 * transcription worker's `TranscriptionOutcomeRecorder`.
 *
 * Every write is the repository's conditional one — the status still `processing`, the lease
 * still the one the last renewal set — and **an edge is announced only on its `true`
 * branch**. A transition that lost its race changed nothing: the row was deleted mid-run, or
 * its lease expired and went to another worker. There is nothing to announce, the patch is
 * discarded, and the thumbnail it may have written is removed.
 */
export class FileOutcomeRecorder {
  constructor(
    private readonly files: MeetingFileRepository,
    private readonly storage: MeetingFileStorage,
    private readonly events: EventBus,
    private readonly logger: Logger,
    /** The worker's shutdown signal: what tells a step that was cut short from one that failed. */
    private readonly shutdown: AbortSignal,
  ) {}

  /** `claimNext` committed this edge itself; the claim returning a row is its "one row changed". */
  claimed(claimed: ClaimedFile, startedAt: number): void {
    this.logTransition(claimed, claimed.previousStatus, 'processing', startedAt);
    this.publish(claimed, 'processing');
  }

  /** The purge the worker announces after a soft delete: `deleted` again, which is idempotent. */
  purged(claimed: ClaimedFile): void {
    this.publish(claimed, 'deleted');
  }

  /** Every step ran: the patch they accumulated, conditional on the lease the last renewal set. */
  async ready(
    claimed: ClaimedFile,
    held: Date | null,
    patch: StepPatch,
    startedAt: number,
  ): Promise<void> {
    const ready = { ...patch, processedAt: new Date(), leasedUntil: null };
    const changed = await this.files.transition(claimed.id, 'processing', 'ready', ready, held);

    if (changed) {
      this.logTransition(claimed, 'processing', 'ready', startedAt);
      this.publish(claimed, 'ready', ready);
    } else {
      this.logLost(claimed, 'ready');
      await this.discard(patch);
    }
  }

  /**
   * A step threw. Shutdown is not the file's fault — the step let go because it was told to —
   * so the row is released for the next claim instead of recording a failure the user would
   * have to retry. Any other cause is the file's: only a `StepError`'s copy reaches
   * `failureReason`, and whatever the earlier steps produced is kept, since a checksum from
   * verify is still true of the bytes even when preview could not read them.
   */
  async failed(
    claimed: ClaimedFile,
    held: Date | null,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    if (this.shutdown.aborted) {
      await this.release(claimed, held, startedAt, patchBefore(error));

      return;
    }

    const cause = error instanceof StepFailure ? error.cause : error;
    const reason =
      cause instanceof StepError ? cause.userMessage : MEETING_FILE_PROCESSING_FAILED_MESSAGE;

    this.logger.error(
      `File ${claimed.id} of meeting ${claimed.meetingId}: step failed (${reason})`,
      cause instanceof Error ? cause.stack : String(cause),
    );
    await this.fail(claimed, held, reason, startedAt, patchBefore(error));
  }

  /** `failureReason` is copy safe to show: a step's own, or one the worker chose. */
  async fail(
    claimed: ClaimedFile,
    lease: Date | null,
    failureReason: string,
    startedAt: number,
    patch: StepPatch = {},
  ): Promise<void> {
    const failed = { ...patch, failureReason, leasedUntil: null };
    const changed = await this.files.transition(claimed.id, 'processing', 'failed', failed, lease);

    if (changed) {
      this.logTransition(claimed, 'processing', 'failed', startedAt);
      this.publish(claimed, 'failed', failed);
    } else {
      this.logLost(claimed, 'failed');
      await this.discard(patch);
    }
  }

  /**
   * The way out for a step cut short by shutdown: the row goes back to `uploaded` — the
   * lease-expiry edge, taken early and on purpose — for the next worker to claim afresh, and
   * whatever the earlier steps wrote is removed so that claim starts clean. The claim count
   * stays as it is: a deploy that keeps landing on the same file is still a file that keeps
   * not finishing.
   */
  private async release(
    claimed: ClaimedFile,
    lease: Date | null,
    startedAt: number,
    patch: StepPatch,
  ): Promise<void> {
    const changed = await this.files.transition(
      claimed.id,
      'processing',
      'uploaded',
      { leasedUntil: null },
      lease,
    );

    if (changed) {
      this.logTransition(claimed, 'processing', 'uploaded', startedAt);
      this.publish(claimed, 'uploaded', { leasedUntil: null });
    } else {
      this.logLost(claimed, 'uploaded');
    }

    await this.discard(patch);
  }

  /**
   * A result nobody will record must not leave bytes behind: a thumbnail written for a row
   * that was deleted mid-run would otherwise outlive the purge, which ran before it existed.
   */
  private async discard(patch: StepPatch): Promise<void> {
    if (patch.thumbnailKey !== undefined) {
      await this.storage.remove(patch.thumbnailKey);
    }
  }

  /**
   * The one place the worker announces a change, and never before the write that made it has
   * committed: every caller above publishes on the `true` branch of its conditional update.
   * A transition that lost its race changed nothing, so there is nothing to announce — and
   * publishing there would tell a watching page the opposite of what the row says.
   *
   * The row is reconstructed from the claim plus the patch just written rather than re-read:
   * a re-read costs a query per transition and would answer with whatever a later writer has
   * done since, which is not what this event is about.
   */
  private publish(
    claimed: ClaimedFile,
    status: MeetingFileStatus,
    patch: TransitionPatch = {},
  ): void {
    this.events.publish(
      new MeetingFileChangedEvent(
        claimed.meetingId,
        toMeetingFile({ ...claimed, ...patch, status }),
      ),
    );
  }

  private logTransition(claimed: ClaimedFile, from: string, to: string, startedAt: number): void {
    this.logger.log(
      `File ${claimed.id} of meeting ${claimed.meetingId}: ${from} -> ${to} in ${String(Date.now() - startedAt)}ms`,
    );
  }

  private logLost(claimed: ClaimedFile, to: string): void {
    this.logger.warn(
      `File ${claimed.id} of meeting ${claimed.meetingId}: not moved to ${to} — the row was deleted or its lease expired and was reclaimed mid-run; result discarded`,
    );
  }
}
