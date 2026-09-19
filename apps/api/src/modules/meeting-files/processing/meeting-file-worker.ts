import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MEETING_FILE_PROCESSING_FAILED_MESSAGE } from '@repo/shared';

import { MeetingFileUploadRepository } from '../services/meeting-file-upload.repository';
import type { MeetingFileUploadRecord } from '../services/meeting-file-upload.mapper';
import { thumbnailKeyOf } from '../services/meeting-file.mapper';
import { MeetingFileRepository } from '../services/meeting-file.repository';
import type { ClaimedFile } from '../services/meeting-file.repository';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { PIPELINE } from './pipeline';
import { StepError } from './step';
import type { ProcessingStep, StepPatch } from './step';

/** The string token the worker is also registered under, so an e2e spec can reach `drain()`. */
export const MEETING_FILE_WORKER = 'MEETING_FILE_WORKER';

/** Injection token for the step list, so the unit spec can substitute its own. */
export const PIPELINE_STEPS = 'MEETING_FILE_PIPELINE_STEPS';

/** Shared with the web app, which shows it for a `failed` row that carries no reason. */
export const GENERIC_FAILURE = MEETING_FILE_PROCESSING_FAILED_MESSAGE;
export const REPEATED_FAILURE = 'Processing failed after repeated attempts';

/**
 * Claims, not failures. A row claimed for the (MAX_ATTEMPTS + 1)th time is failed unrun; a
 * deleted row or an expired upload session claimed that often is marked purged unrun, with
 * the keys in the log, so no kind of row can be reclaimed forever.
 */
export const MAX_ATTEMPTS = 3;

/**
 * The in-process polling worker. One claim per tick: a file, or — when no file is claimable —
 * an expired upload session, whose chunk tree it removes.
 *
 * A claimed file row is either purged (it was deleted) or run through the pipeline and moved
 * to `ready` or `failed` with a conditional transition on both the status and the lease this
 * claim was given, so a row that was deleted mid-run — or whose lease expired and went to
 * another worker — is left alone, the patch discarded, and the thumbnail it may have written
 * removed.
 *
 * Behind `MEETING_FILES_WORKER_ENABLED`: `pnpm dev` runs one API process, and a second entry
 * point would be a second thing to start everywhere for a pipeline whose steps take
 * milliseconds. Every replica polls when it is on, bounded by one indexed claim per tick. The
 * API e2e suite runs with it off and calls `drain()` instead, which is what makes the row's
 * state after processing deterministic.
 */
@Injectable()
export class MeetingFileWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MeetingFileWorker.name);
  private readonly enabled: boolean;
  private readonly leaseSeconds: number;
  private readonly pollMs: number;
  private readonly steps: ReadonlyArray<ProcessingStep>;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    config: ConfigService,
    private readonly files: MeetingFileRepository,
    private readonly uploads: MeetingFileUploadRepository,
    private readonly storage: MeetingFileStorage,
    @Optional() @Inject(PIPELINE_STEPS) steps?: ReadonlyArray<ProcessingStep>,
  ) {
    this.enabled = config.get<boolean>('MEETING_FILES_WORKER_ENABLED', true);
    this.leaseSeconds = config.get<number>('MEETING_FILES_LEASE_SECONDS', 60);
    this.pollMs = config.get<number>('MEETING_FILES_POLL_MS', 1000);
    this.steps = steps ?? PIPELINE;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Worker disabled (MEETING_FILES_WORKER_ENABLED=false)');

      return;
    }

    this.logger.log(
      `Worker polling every ${String(this.pollMs)}ms with a ${String(this.leaseSeconds)}s lease`,
    );
    this.schedule(0);
  }

  /** Stops the loop and waits for a tick in progress, so shutdown never abandons a claim. */
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  /** Handles every claimable row and returns how many there were. The test handle. */
  drain(): Promise<number> {
    return this.drainFrom(0);
  }

  /**
   * One claim, of either kind. Resolves to whether there was a row to handle.
   *
   * Files first: a file someone is waiting on outranks a chunk tree nobody will read again.
   * An expired session is only looked for once there is no file left to process, which also
   * means `drain()` ends with every session of both kinds handled.
   */
  async tick(): Promise<boolean> {
    const claimed = await this.files.claimNext(this.leaseSeconds);

    if (claimed !== null) {
      await this.handle(claimed);

      return true;
    }

    const expired = await this.uploads.claimExpired(this.leaseSeconds);

    if (expired !== null) {
      await this.purgeUpload(expired);

      return true;
    }

    return false;
  }

  private async drainFrom(count: number): Promise<number> {
    return (await this.tick()) ? this.drainFrom(count + 1) : count;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.inFlight = this.tick()
        .then((handled) => this.schedule(handled ? 0 : this.pollMs))
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

  private async handle(claimed: ClaimedFile): Promise<void> {
    const startedAt = Date.now();

    if (claimed.status === 'deleted') {
      await this.purge(claimed, startedAt);

      return;
    }

    const lease = claimed.leasedUntil;

    this.logTransition(claimed, claimed.previousStatus, 'processing', startedAt);

    if (claimed.attempts > MAX_ATTEMPTS) {
      this.logger.error(
        `File ${claimed.id} claimed ${String(claimed.attempts)} times; failing it unrun`,
      );
      await this.fail(claimed, lease, REPEATED_FAILURE, startedAt);

      return;
    }

    let patch: StepPatch;

    try {
      patch = await this.runSteps(claimed);
    } catch (error) {
      const cause = error instanceof StepFailure ? error.cause : error;
      const reason = cause instanceof StepError ? cause.userMessage : GENERIC_FAILURE;

      this.logger.error(
        `File ${claimed.id} of meeting ${claimed.meetingId}: step failed (${reason})`,
        cause instanceof Error ? cause.stack : String(cause),
      );
      // Whatever the earlier steps produced is kept: a checksum from verify is still true of
      // the bytes even when preview could not read them.
      await this.fail(claimed, lease, reason, startedAt, patchBefore(error));

      return;
    }

    const changed = await this.files.transition(
      claimed.id,
      'processing',
      'ready',
      { ...patch, processedAt: new Date(), leasedUntil: null },
      lease,
    );

    if (changed) {
      this.logTransition(claimed, 'processing', 'ready', startedAt);
    } else {
      this.logLost(claimed, 'ready');
      await this.discard(patch);
    }
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
   * Runs the steps in order, accumulating the patch. A throw carries the patch so far on it,
   * so a later failure does not discard an earlier step's result.
   */
  private async runSteps(record: ClaimedFile): Promise<StepPatch> {
    const context = { record, storage: this.storage, logger: this.logger };

    return this.steps.reduce<Promise<StepPatch>>(async (previous, step) => {
      const patch = await previous;

      try {
        return { ...patch, ...(await step.run(context)) };
      } catch (error) {
        throw new StepFailure(step.name, patch, error);
      }
    }, Promise.resolve({}));
  }

  private async fail(
    claimed: ClaimedFile,
    lease: Date | null,
    failureReason: string,
    startedAt: number,
    patch: StepPatch = {},
  ): Promise<void> {
    const changed = await this.files.transition(
      claimed.id,
      'processing',
      'failed',
      { ...patch, failureReason, leasedUntil: null },
      lease,
    );

    if (changed) {
      this.logTransition(claimed, 'processing', 'failed', startedAt);
    } else {
      this.logLost(claimed, 'failed');
      await this.discard(patch);
    }
  }

  /**
   * Removes the object and the thumbnail — by the key the preview step derives, not only the
   * one on the row: a file deleted while it was processing can be purged before the step has
   * written the thumbnail, and the row never learns the key. `remove` is idempotent, so a
   * thumbnail that never existed costs one `rm -f`.
   *
   * A purge that keeps throwing (an object the process cannot unlink) is given up on after
   * MAX_ATTEMPTS claims like a processing row is, else the row is reclaimed every lease for
   * ever: it is marked purged and the keys logged at error level for an operator.
   */
  private async purge(claimed: ClaimedFile, startedAt: number): Promise<void> {
    if (claimed.attempts > MAX_ATTEMPTS) {
      this.logger.error(
        `File ${claimed.id} claimed ${String(claimed.attempts)} times for purge; marking it purged with objects possibly left at ${claimed.storageKey} and ${thumbnailKeyOf(claimed.storageKey)}`,
      );
      await this.files.markPurged(claimed.id);

      return;
    }

    await this.storage.remove(claimed.storageKey);
    await this.storage.remove(thumbnailKeyOf(claimed.storageKey));
    await this.files.markPurged(claimed.id);
    this.logger.log(
      `File ${claimed.id} of meeting ${claimed.meetingId}: purged in ${String(Date.now() - startedAt)}ms`,
    );
  }

  /**
   * An expired or aborted session: remove its chunk tree, then mark it purged — in that
   * order, so a crash between the two leaves a row that is claimed again rather than chunks
   * nobody will ever collect. `removeTree` is idempotent, so the retry costs one `rm -rf`.
   *
   * Given up on after MAX_ATTEMPTS claims, as a file's purge is, with the directory logged
   * for an operator: a tree the process cannot remove must not be reclaimed every lease for
   * ever.
   */
  private async purgeUpload(upload: MeetingFileUploadRecord): Promise<void> {
    const startedAt = Date.now();

    if (upload.attempts > MAX_ATTEMPTS) {
      this.logger.error(
        `Upload ${upload.id} claimed ${String(upload.attempts)} times for purge; marking it purged with chunks possibly left under uploads/${upload.id}`,
      );
      await this.uploads.markPurged(upload.id);

      return;
    }

    await this.storage.removeTree(upload.id);
    await this.uploads.markPurged(upload.id);
    this.logger.log(
      `Upload ${upload.id} of meeting ${upload.meetingId}: chunks purged in ${String(Date.now() - startedAt)}ms`,
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

/** Carries the patch accumulated before `step` threw, and the cause, which decides the reason. */
class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly patch: StepPatch,
    override readonly cause: unknown,
  ) {
    super(`Step ${step} failed`);
    this.name = 'StepFailure';
  }
}

function patchBefore(error: unknown): StepPatch {
  return error instanceof StepFailure ? error.patch : {};
}
