import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

export const GENERIC_FAILURE = 'Processing failed. You can still download the file.';
export const REPEATED_FAILURE = 'Processing failed after repeated attempts';

/** Claims, not failures. A row claimed for the (MAX_ATTEMPTS + 1)th time is failed unrun. */
export const MAX_ATTEMPTS = 3;

/**
 * The in-process polling worker. One claim per tick; a claimed row is either purged (it was
 * deleted) or run through the pipeline and moved to `ready` or `failed` with a conditional
 * transition, so a row that was deleted mid-run — or whose lease another worker took — is
 * left alone and the patch discarded.
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

  /** One claim. Resolves to whether there was a row to handle. */
  async tick(): Promise<boolean> {
    const claimed = await this.files.claimNext(this.leaseSeconds);

    if (claimed === null) {
      return false;
    }

    await this.handle(claimed);

    return true;
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

    this.logTransition(claimed, claimed.previousStatus, 'processing', startedAt);

    if (claimed.attempts > MAX_ATTEMPTS) {
      this.logger.error(
        `File ${claimed.id} claimed ${String(claimed.attempts)} times; failing it unrun`,
      );
      await this.fail(claimed, REPEATED_FAILURE, startedAt);

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
      await this.fail(claimed, reason, startedAt, patchBefore(error));

      return;
    }

    const changed = await this.files.transition(claimed.id, 'processing', 'ready', {
      ...patch,
      processedAt: new Date(),
      leasedUntil: null,
    });

    if (changed) {
      this.logTransition(claimed, 'processing', 'ready', startedAt);
    } else {
      this.logLost(claimed, 'ready');
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
    failureReason: string,
    startedAt: number,
    patch: StepPatch = {},
  ): Promise<void> {
    const changed = await this.files.transition(claimed.id, 'processing', 'failed', {
      ...patch,
      failureReason,
      leasedUntil: null,
    });

    if (changed) {
      this.logTransition(claimed, 'processing', 'failed', startedAt);
    } else {
      this.logLost(claimed, 'failed');
    }
  }

  private async purge(claimed: ClaimedFile, startedAt: number): Promise<void> {
    await this.storage.remove(claimed.storageKey);

    if (claimed.thumbnailKey !== null) {
      await this.storage.remove(claimed.thumbnailKey);
    }

    await this.files.markPurged(claimed.id);
    this.logger.log(
      `File ${claimed.id} of meeting ${claimed.meetingId}: purged in ${String(Date.now() - startedAt)}ms`,
    );
  }

  private logTransition(claimed: ClaimedFile, from: string, to: string, startedAt: number): void {
    this.logger.log(
      `File ${claimed.id} of meeting ${claimed.meetingId}: ${from} -> ${to} in ${String(Date.now() - startedAt)}ms`,
    );
  }

  private logLost(claimed: ClaimedFile, to: string): void {
    this.logger.warn(
      `File ${claimed.id} of meeting ${claimed.meetingId}: not moved to ${to} — the row was deleted or re-leased mid-run; result discarded`,
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
