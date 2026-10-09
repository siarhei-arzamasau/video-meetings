import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import {
  MEETING_FILE_TRANSCRIPTION_FAILED_MESSAGE,
  MEETING_FILE_TRANSCRIPTION_REPEATED_FAILURE_MESSAGE,
  meetingFileTranscriptionTimeLimitMessage,
} from '@repo/shared';

import { describeError } from '../../../common/error-message';
import { PollingLoop } from '../../../common/processing/polling-loop';
import { DEFAULT_TRANSCRIPTION_TIMEOUT_SECONDS } from '../../../config/transcription.defaults';
import { MeetingFileHandOvers } from '../services/meeting-file-hand-overs';
import { MeetingFileTranscriptionRepository } from '../services/meeting-file-transcription.repository';
import type { ClaimedTranscription } from '../services/meeting-file-transcription.repository';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { TranscriptionOutcomeRecorder } from './transcription/transcription-outcome-recorder';
import { TRANSCRIPTION_PROVIDER } from './transcription/transcription-provider';
import type { TranscriptionProvider } from './transcription/transcription-provider';
import { runTranscription } from './transcription/transcription-run';

/** The string token the worker is also registered under, so an e2e spec can reach `drain()`. */
export const MEETING_FILE_TRANSCRIPTION_WORKER = 'MEETING_FILE_TRANSCRIPTION_WORKER';

/**
 * Claims, not failures: a transcription claimed for the fourth time is failed unrun. Only a
 * crash gets it there — a graceful shutdown uncounts the claim it hands back — so what the
 * cap bounds is a recording that keeps killing the process that transcribes it.
 */
export const MAX_TRANSCRIPTION_CLAIMS = 3;

/**
 * Transcribes queued recordings, one at a time, in a polling loop of its own.
 *
 * Its own loop rather than a step of `MeetingFileWorker`, which handles one claim per tick: a
 * ten-minute transcription inside it would hold every other upload at `uploaded`. A file is
 * `ready` before this worker ever sees it, and nothing here can change that — every write is
 * to the transcription's own status, conditional on the file still being `ready` and on the
 * lease this claim holds. One loop per process also bounds a replica to one transcription.
 *
 * The user's copy for a failure is decided here, from what happened — the time limit, a
 * fourth claim, anything else — and never from what the provider said, which stays in the log.
 */
@Injectable()
export class MeetingFileTranscriptionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MeetingFileTranscriptionWorker.name);
  private readonly leaseSeconds: number;
  private readonly pollMs: number;
  private readonly loop: PollingLoop;
  /** Aborted on shutdown: the request in flight lets go, and no further claim is taken. */
  private readonly shutdown = new AbortController();
  /** Claims being handled, whoever started the tick — the loop, or `drain()`. */
  private readonly running = new Set<Promise<void>>();
  private readonly recorder: TranscriptionOutcomeRecorder;

  constructor(
    private readonly config: ConfigService,
    private readonly transcriptions: MeetingFileTranscriptionRepository,
    private readonly storage: MeetingFileStorage,
    events: EventBus,
    @Inject(TRANSCRIPTION_PROVIDER) private readonly provider: TranscriptionProvider,
    handOvers: MeetingFileHandOvers,
  ) {
    this.leaseSeconds = config.get<number>('MEETING_FILES_LEASE_SECONDS', 60);
    this.pollMs = config.get<number>('MEETING_FILES_POLL_MS', 1000);
    this.loop = new PollingLoop(() => this.tick(), this.pollMs, this.logger);
    this.recorder = new TranscriptionOutcomeRecorder(
      transcriptions,
      storage,
      events,
      this.logger,
      handOvers,
    );
  }

  /** Polls only where the file worker does, and only while there is something to poll for. */
  onApplicationBootstrap(): void {
    if (!this.config.get<boolean>('MEETING_FILES_WORKER_ENABLED', true)) {
      this.logger.log('Transcription worker disabled (MEETING_FILES_WORKER_ENABLED=false)');
    } else if (!this.isSwitchedOn()) {
      this.logger.log('Transcription is off (MEETING_FILES_TRANSCRIPTION_ENABLED=false)');
    } else {
      this.logger.log(`Transcription worker polling every ${String(this.pollMs)}ms`);
      this.loop.start();
    }
  }

  /**
   * Hangs up on the provider, waits for the claim in flight to be handed back, and takes no
   * other. **`onModuleDestroy`, not `onApplicationShutdown`:** handing a claim back is a
   * write, and `PrismaService` disconnects in its own `onModuleDestroy` — which Nest runs
   * last for a global module, so here the connection is still open. In the later hook the
   * write would reopen one that nothing is left to close.
   */
  async onModuleDestroy(): Promise<void> {
    this.shutdown.abort();
    await this.loop.stop();
    await Promise.allSettled(this.running);
  }

  /** Handles every claimable transcription and returns how many there were. The test handle. */
  drain(): Promise<number> {
    return this.drainFrom(0);
  }

  /**
   * One claim. Resolves to whether there was one to handle. Idle while the setting is off —
   * asked for per tick, so a queued row simply waits for it to come back — and once shutdown
   * has begun, or the row this process has just released would be claimed straight back.
   */
  async tick(): Promise<boolean> {
    if (this.shutdown.signal.aborted || !this.isSwitchedOn()) {
      return false;
    }

    const claimed = await this.transcriptions.claimNext(this.leaseSeconds);

    if (claimed === null) {
      return false;
    }

    const handling = this.handle(claimed);

    this.running.add(handling);
    try {
      await handling;
    } finally {
      this.running.delete(handling);
    }

    return true;
  }

  private isSwitchedOn(): boolean {
    return this.config.get<boolean>('MEETING_FILES_TRANSCRIPTION_ENABLED', false);
  }

  private async drainFrom(count: number): Promise<number> {
    return (await this.tick()) ? this.drainFrom(count + 1) : count;
  }

  private async handle(claimed: ClaimedTranscription): Promise<void> {
    const startedAt = Date.now();

    await this.recorder.claimed(claimed, startedAt);

    if (claimed.transcriptionAttempts > MAX_TRANSCRIPTION_CLAIMS) {
      this.logger.error(
        `File ${claimed.id} claimed ${String(claimed.transcriptionAttempts)} times for transcription; failing it unrun`,
      );
      await this.recorder.fail(
        claimed,
        claimed.transcriptionLeasedUntil,
        MEETING_FILE_TRANSCRIPTION_REPEATED_FAILURE_MESSAGE,
        startedAt,
      );

      return;
    }

    await this.transcribeAndRecord(claimed, startedAt);
  }

  /**
   * Asks the provider, then writes what happened. What ended the request decides what the row
   * is told: a lost claim nothing at all, shutdown a release, the time limit a failure that
   * names it, and anything else the generic one.
   */
  private async transcribeAndRecord(
    claimed: ClaimedTranscription,
    startedAt: number,
  ): Promise<void> {
    const limitSeconds = this.config.get<number>(
      'TRANSCRIPTION_TIMEOUT_SECONDS',
      DEFAULT_TRANSCRIPTION_TIMEOUT_SECONDS,
    );
    const { held, outcome, timedOut, shuttingDown } = await runTranscription({
      claimed,
      provider: this.provider,
      storage: this.storage,
      leases: this.transcriptions,
      logger: this.logger,
      leaseSeconds: this.leaseSeconds,
      limitSeconds,
      shutdown: this.shutdown.signal,
    });

    if (held === null) {
      this.recorder.lost(claimed, 'finished');
    } else if ('text' in outcome) {
      await this.recorder.complete(claimed, held, outcome.text, startedAt);
    } else if (shuttingDown) {
      // As the run saw it when the provider settled, not as the signal reads now: a shutdown
      // that began after an ordinary error must not turn that error into a second attempt.
      await this.recorder.release(claimed, held, startedAt);
    } else {
      const reason = timedOut
        ? meetingFileTranscriptionTimeLimitMessage(limitSeconds)
        : MEETING_FILE_TRANSCRIPTION_FAILED_MESSAGE;

      this.logger.error(
        `File ${claimed.id} of meeting ${claimed.meetingId}: transcription failed (${reason})`,
        describeError(outcome.error),
      );
      await this.recorder.fail(claimed, held, reason, startedAt);
    }
  }
}
