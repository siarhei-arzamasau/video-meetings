import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import type { MeetingFileStatus } from '@repo/shared';
import { MEETING_FILE_PROCESSING_FAILED_MESSAGE } from '@repo/shared';

import { MeetingFileChangedEvent } from '../events/meeting-file-changed.event';
import { MeetingFileUploadRepository } from '../services/meeting-file-upload.repository';
import { toMeetingFile } from '../services/meeting-file.mapper';
import { MeetingFileRepository } from '../services/meeting-file.repository';
import type { ClaimedFile, TransitionPatch } from '../services/meeting-file.repository';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { startLeaseHeartbeat } from './lease-heartbeat';
import { MeetingFilePurger } from './meeting-file-purger';
import { PIPELINE } from './pipeline';
import { PollingLoop } from './polling-loop';
import { StepError } from './step';
import type { ProcessingStep, StepPatch } from './step';
import { StepFailure, patchBefore } from './step-failure';

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
  private readonly loop: PollingLoop;
  /** Aborted on shutdown; every step receives its signal, and a step waiting on a third party lets go. */
  private readonly shutdown = new AbortController();
  private readonly purger: MeetingFilePurger;

  constructor(
    config: ConfigService,
    private readonly files: MeetingFileRepository,
    private readonly uploads: MeetingFileUploadRepository,
    private readonly storage: MeetingFileStorage,
    private readonly events: EventBus,
    @Optional() @Inject(PIPELINE_STEPS) steps?: ReadonlyArray<ProcessingStep>,
  ) {
    this.enabled = config.get<boolean>('MEETING_FILES_WORKER_ENABLED', true);
    this.leaseSeconds = config.get<number>('MEETING_FILES_LEASE_SECONDS', 60);
    this.pollMs = config.get<number>('MEETING_FILES_POLL_MS', 1000);
    this.steps = steps ?? PIPELINE;
    this.loop = new PollingLoop(() => this.tick(), this.pollMs, this.logger);
    this.purger = new MeetingFilePurger(
      this.files,
      this.uploads,
      this.storage,
      this.logger,
      MAX_ATTEMPTS,
      (claimed) => {
        this.publish(claimed, 'deleted');
      },
    );
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Worker disabled (MEETING_FILES_WORKER_ENABLED=false)');

      return;
    }

    this.logger.log(
      `Worker polling every ${String(this.pollMs)}ms with a ${String(this.leaseSeconds)}s lease`,
    );
    this.loop.start();
  }

  /**
   * Stops the loop, tells a step in flight to let go, and waits for the tick to finish, so
   * shutdown never abandons a claim. The abort matters now that a step can take minutes: a
   * transcription in progress is dropped and its row handed back (see `release`), rather
   * than the process waiting on a third party for up to `TRANSCRIPTION_TIMEOUT_SECONDS` —
   * which is longer than any orchestrator's grace period, so the wait would end in a
   * SIGKILL and a lapsed lease anyway.
   */
  async onApplicationShutdown(): Promise<void> {
    // Aborted before the wait, never after: the tick in flight has to be told to let go
    // first, or `stop` would wait out the step it is meant to cut short.
    this.shutdown.abort();
    await this.loop.stop();
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
      await this.purger.purgeUpload(expired);

      return true;
    }

    return false;
  }

  private async drainFrom(count: number): Promise<number> {
    return (await this.tick()) ? this.drainFrom(count + 1) : count;
  }

  private async handle(claimed: ClaimedFile): Promise<void> {
    const startedAt = Date.now();

    if (claimed.status === 'deleted') {
      await this.purger.purgeFile(claimed, startedAt);

      return;
    }

    const lease = claimed.leasedUntil;

    this.logTransition(claimed, claimed.previousStatus, 'processing', startedAt);
    // `claimNext` committed this one; the claim returning a row is its "one row changed".
    this.publish(claimed, 'processing');

    if (claimed.attempts > MAX_ATTEMPTS) {
      this.logger.error(
        `File ${claimed.id} claimed ${String(claimed.attempts)} times; failing it unrun`,
      );
      await this.fail(claimed, lease, REPEATED_FAILURE, startedAt);

      return;
    }

    const { held, outcome } = await this.runUnderLease(claimed, lease);

    if ('error' in outcome) {
      await this.recordFailure(claimed, held, outcome.error, startedAt);

      return;
    }

    await this.recordReady(claimed, held, outcome.patch, startedAt);
  }

  /**
   * Runs the steps with the claim's lease held, and hands back both the outcome and the lease
   * the row actually holds — which is what every write below is conditional on.
   *
   * The lease is extended while the steps run: a step slower than the lease — transcribing an
   * hour of audio — would otherwise have its row reclaimed by another worker and its result
   * thrown away for no reason. The heartbeat is stopped exactly once, whichever way the steps
   * ended, and before anything is written, which is why its `stop` waits for a renewal still
   * in flight. A renewal that found the row was no longer ours leaves `null`, which makes the
   * caller's conditional updates miss on purpose and the result be discarded.
   */
  private async runUnderLease(
    claimed: ClaimedFile,
    lease: Date | null,
  ): Promise<{ held: Date | null; outcome: { patch: StepPatch } | { error: unknown } }> {
    const heartbeat = startLeaseHeartbeat({
      files: this.files,
      logger: this.logger,
      fileId: claimed.id,
      meetingId: claimed.meetingId,
      lease,
      leaseSeconds: this.leaseSeconds,
    });
    let outcome: { patch: StepPatch } | { error: unknown };

    try {
      outcome = { patch: await this.runSteps(claimed) };
    } catch (error) {
      outcome = { error };
    }

    return { held: await heartbeat.stop(), outcome };
  }

  /**
   * A step threw. Shutdown is not the file's fault — the step let go because it was told to —
   * so the row is released for the next claim instead of recording a failure the user would
   * have to retry. Any other cause is the file's: only a `StepError`'s copy reaches
   * `failureReason`, and whatever the earlier steps produced is kept, since a checksum from
   * verify is still true of the bytes even when preview could not read them.
   */
  private async recordFailure(
    claimed: ClaimedFile,
    held: Date | null,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    if (this.shutdown.signal.aborted) {
      await this.release(claimed, held, startedAt, patchBefore(error));

      return;
    }

    const cause = error instanceof StepFailure ? error.cause : error;
    const reason = cause instanceof StepError ? cause.userMessage : GENERIC_FAILURE;

    this.logger.error(
      `File ${claimed.id} of meeting ${claimed.meetingId}: step failed (${reason})`,
      cause instanceof Error ? cause.stack : String(cause),
    );
    await this.fail(claimed, held, reason, startedAt, patchBefore(error));
  }

  /** Every step ran: the patch they accumulated, conditional on the lease the last renewal set. */
  private async recordReady(
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
   * A result nobody will record must not leave bytes behind: a thumbnail written for a row
   * that was deleted mid-run would otherwise outlive the purge, which ran before it existed.
   */
  private async discard(patch: StepPatch): Promise<void> {
    if (patch.thumbnailKey !== undefined) {
      await this.storage.remove(patch.thumbnailKey);
    }

    if (patch.transcriptKey !== undefined) {
      await this.storage.remove(patch.transcriptKey);
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
   * Runs the steps in order, accumulating the patch. A throw carries the patch so far on it,
   * so a later failure does not discard an earlier step's result.
   */
  private async runSteps(record: ClaimedFile): Promise<StepPatch> {
    const context = {
      record,
      storage: this.storage,
      logger: this.logger,
      signal: this.shutdown.signal,
    };

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
