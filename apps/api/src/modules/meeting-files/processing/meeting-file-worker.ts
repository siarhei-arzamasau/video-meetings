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
import { MEETING_FILE_PROCESSING_FAILED_MESSAGE } from '@repo/shared';

import { MeetingFileHandOvers } from '../services/meeting-file-hand-overs';
import { MeetingFileUploadRepository } from '../services/meeting-file-upload.repository';
import { MeetingFileRepository } from '../services/meeting-file.repository';
import type { ClaimedFile } from '../services/meeting-file.repository';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { FileOutcomeRecorder } from './file-outcome-recorder';
import { startLeaseHeartbeat } from './lease-heartbeat';
import { MeetingFilePurger } from './meeting-file-purger';
import { PIPELINE } from './pipeline';
import { PollingLoop } from './polling-loop';
import type { ProcessingStep, StepContext, StepPatch } from './step';
import { runSteps } from './step-failure';

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
 * removed. Those writes, and every announcement, are `FileOutcomeRecorder`'s; what stays here
 * is the loop, the claim, and the steps run under its lease.
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
  private readonly recorder: FileOutcomeRecorder;
  private readonly purger: MeetingFilePurger;

  constructor(
    config: ConfigService,
    private readonly files: MeetingFileRepository,
    private readonly uploads: MeetingFileUploadRepository,
    private readonly storage: MeetingFileStorage,
    private readonly events: EventBus,
    @Optional() @Inject(PIPELINE_STEPS) steps?: ReadonlyArray<ProcessingStep>,
    // Optional for the reason the step list is: the unit spec builds the worker from a handful
    // of fakes. The application always has one — the handlers beside this require it, so a
    // module that does not provide it does not boot.
    @Optional() handOvers?: MeetingFileHandOvers,
  ) {
    this.enabled = config.get<boolean>('MEETING_FILES_WORKER_ENABLED', true);
    this.leaseSeconds = config.get<number>('MEETING_FILES_LEASE_SECONDS', 60);
    this.pollMs = config.get<number>('MEETING_FILES_POLL_MS', 1000);
    this.steps = steps ?? PIPELINE;
    this.loop = new PollingLoop(() => this.tick(), this.pollMs, this.logger);
    this.recorder = new FileOutcomeRecorder(
      this.files,
      this.storage,
      this.events,
      this.logger,
      this.shutdown.signal,
      handOvers ?? new MeetingFileHandOvers(),
    );
    this.purger = new MeetingFilePurger(
      this.files,
      this.uploads,
      this.storage,
      this.logger,
      MAX_ATTEMPTS,
      (claimed) => {
        this.recorder.purged(claimed);
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
   * shutdown never abandons a claim. The abort is for a step that waits on something outside
   * the process: its row is handed back (see `release`) rather than the process waiting for
   * as long as that step's own timeout allows — which can outlast an orchestrator's grace
   * period, so the wait would end in a SIGKILL and a lapsed lease anyway. No step does
   * today: transcription, which did, has a worker of its own.
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

    await this.recorder.claimed(claimed, startedAt);

    if (claimed.attempts > MAX_ATTEMPTS) {
      this.logger.error(
        `File ${claimed.id} claimed ${String(claimed.attempts)} times; failing it unrun`,
      );
      await this.recorder.fail(claimed, lease, REPEATED_FAILURE, startedAt);

      return;
    }

    const { held, outcome } = await this.runUnderLease(claimed, lease);

    if ('error' in outcome) {
      await this.recorder.failed(claimed, held, outcome.error, startedAt);

      return;
    }

    await this.recorder.ready(claimed, held, outcome.patch, startedAt);
  }

  /**
   * Runs the steps with the claim's lease held, and hands back both the outcome and the lease
   * the row actually holds — which is what every write below is conditional on.
   *
   * The lease is extended while the steps run: a step slower than the lease — checksumming
   * a gigabyte off a slow disk — would otherwise have its row reclaimed by another worker and
   * its result thrown away. The heartbeat is stopped exactly once, whichever way the steps
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
      outcome = { patch: await runSteps(this.steps, this.stepContext(claimed)) };
    } catch (error) {
      outcome = { error };
    }

    return { held: await heartbeat.stop(), outcome };
  }

  private stepContext(record: ClaimedFile): StepContext {
    return { record, storage: this.storage, logger: this.logger, signal: this.shutdown.signal };
  }
}
