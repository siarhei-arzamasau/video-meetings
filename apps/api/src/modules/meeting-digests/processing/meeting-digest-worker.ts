import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';
import { MEETING_DIGEST_REPEATED_FAILURE_MESSAGE } from '@repo/shared';

import { PollingLoop } from '../../../common/processing/polling-loop';
import { DEFAULT_MEETING_DIGEST_TIMEOUT_SECONDS } from '../../../config/meeting-digest.defaults';
import { FindMeetingTranscriptsQuery } from '../../meeting-files/queries/find-meeting-transcripts.query';
import type { MeetingTranscripts } from '../../meeting-files/queries/find-meeting-transcripts.query';
import {
  MAX_DIGEST_TRANSCRIPT_CHARACTERS,
  MEETING_DIGEST_MODEL,
} from '../meeting-digest.constants';
import { MeetingDigestClaimRepository } from '../services/meeting-digest-claim.repository';
import type { ClaimedDigest } from '../services/meeting-digest-claim.repository';
import { MeetingDigestGenerator } from '../services/meeting-digest-generator';
import { PendingDigestRequests } from '../services/pending-digest-requests';
import { costOf, failureReasonOf } from './meeting-digest-failure';
import { DigestOutcomeRecorder, spendOf } from './meeting-digest-outcome-recorder';
import { DigestInterruption, runDigestGeneration } from './meeting-digest-run';
import type { DigestRun } from './meeting-digest-run';

/** The string token the worker is also registered under, so an e2e spec can reach `drain()`. */
export const MEETING_DIGEST_WORKER = 'MEETING_DIGEST_WORKER';

/**
 * Claims, not failures: a digest claimed for the fourth time is failed unrun. Only a crash
 * gets it there — a graceful shutdown uncounts the claim it hands back — so what the cap
 * bounds is a meeting whose generation keeps killing the process that runs it.
 */
export const MAX_DIGEST_CLAIMS = 3;

/**
 * Generates queued digests, one at a time, in a polling loop of its own — the transcription
 * worker's shape, on this module's own row.
 *
 * Nothing here can touch a file or a transcription: it reads transcripts through a query
 * `meeting-files` answers, and every write is to the digest row, conditional on the lease
 * this claim holds. One loop per process also bounds a replica to one Claude Code process.
 *
 * **There is no automatic retry.** The first error ends the generation, with fixed copy
 * chosen here from what happened — the time limit, the transcripts' length, a fourth claim,
 * anything else — and never from what the SDK or Anthropic said, which stays in the log.
 */
@Injectable()
export class MeetingDigestWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MeetingDigestWorker.name);
  private readonly leaseSeconds: number;
  private readonly pollMs: number;
  private readonly loop: PollingLoop;
  /** Aborted on shutdown: the generation in flight lets go, and no further claim is taken. */
  private readonly shutdown = new AbortController();
  /** Claims being handled, whoever started the tick — the loop, or `drain()`. */
  private readonly running = new Set<Promise<void>>();
  private readonly recorder: DigestOutcomeRecorder;

  constructor(
    private readonly config: ConfigService,
    private readonly claims: MeetingDigestClaimRepository,
    private readonly queryBus: QueryBus,
    private readonly generator: MeetingDigestGenerator,
    private readonly pending: PendingDigestRequests,
  ) {
    // The files worker's lease and poll: one pace for every worker a process runs, and no
    // second pair of variables that would only ever be set to the same values.
    this.leaseSeconds = config.get<number>('MEETING_FILES_LEASE_SECONDS', 60);
    this.pollMs = config.get<number>('MEETING_FILES_POLL_MS', 1000);
    this.loop = new PollingLoop(() => this.tick(), this.pollMs, this.logger);
    this.recorder = new DigestOutcomeRecorder(claims, this.logger);
  }

  /** Polls only where the file worker does, and only while there is something to poll for. */
  onApplicationBootstrap(): void {
    if (!this.config.get<boolean>('MEETING_FILES_WORKER_ENABLED', true)) {
      this.logger.log('Digest worker disabled (MEETING_FILES_WORKER_ENABLED=false)');
    } else if (!this.isSwitchedOn()) {
      this.logger.log('The meeting digest is off (MEETING_DIGEST_ENABLED=false)');
    } else {
      this.logger.log(`Digest worker polling every ${String(this.pollMs)}ms`);
      this.loop.start();
    }
  }

  /**
   * Hangs up on Claude, waits for the claim in flight to be handed back, and takes no other.
   * `onModuleDestroy`, not `onApplicationShutdown`, for the transcription worker's reason:
   * handing a claim back is a write, and here the database connection is still open.
   */
  async onModuleDestroy(): Promise<void> {
    this.shutdown.abort();
    await this.loop.stop();
    await Promise.allSettled(this.running);
  }

  /**
   * Handles every claimable digest and returns how many there were. The test handle — which
   * first waits for the requests an event has started and not yet written, so that "the
   * recording was transcribed, now drain" finds the row the transcription asked for.
   */
  async drain(): Promise<number> {
    await this.pending.settled();

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

    const claimed = await this.claims.claimNext(this.leaseSeconds);

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
    return this.config.get<boolean>('MEETING_DIGEST_ENABLED', false);
  }

  private async drainFrom(count: number): Promise<number> {
    return (await this.tick()) ? this.drainFrom(count + 1) : count;
  }

  private async handle(claimed: ClaimedDigest): Promise<void> {
    const startedAt = Date.now();

    this.recorder.claimed(claimed);

    if (claimed.attempts > MAX_DIGEST_CLAIMS) {
      this.logger.error(
        `Digest of meeting ${claimed.meetingId} claimed ${String(claimed.attempts)} times; failing it unrun`,
      );
      await this.recorder.fail(
        claimed,
        claimed.leasedUntil,
        { reason: MEETING_DIGEST_REPEATED_FAILURE_MESSAGE, model: MEETING_DIGEST_MODEL },
        startedAt,
      );

      return;
    }

    const limitSeconds = this.config.get<number>(
      'MEETING_DIGEST_TIMEOUT_SECONDS',
      DEFAULT_MEETING_DIGEST_TIMEOUT_SECONDS,
    );
    const run = await runDigestGeneration({
      claimed,
      readTranscripts: (meetingId) => this.transcriptsOf(meetingId),
      generate: (transcripts, signal) => this.generator.generate(transcripts, signal),
      leases: this.claims,
      logger: this.logger,
      leaseSeconds: this.leaseSeconds,
      limitSeconds,
      shutdown: this.shutdown.signal,
    });

    await this.record(claimed, run, limitSeconds, startedAt);
  }

  private transcriptsOf(meetingId: string): Promise<MeetingTranscripts> {
    return this.queryBus.execute<FindMeetingTranscriptsQuery, MeetingTranscripts>(
      new FindMeetingTranscriptsQuery(meetingId, MAX_DIGEST_TRANSCRIPT_CHARACTERS),
    );
  }

  /**
   * Writes what happened. What ended the generation decides what the row is told: a lost
   * claim nothing at all, an answer the digest, no recording left no status, shutdown a
   * release, and anything else a failure in the sentence `failureReasonOf` picks.
   */
  private async record(
    claimed: ClaimedDigest,
    { held, outcome, interruptedBy }: DigestRun,
    limitSeconds: number,
    startedAt: number,
  ): Promise<void> {
    if (held === null) {
      this.recorder.abandoned(claimed, spendOf(outcome), startedAt);
    } else if ('generated' in outcome) {
      const { generated, sourceFileIds } = outcome;

      await this.recorder.complete(claimed, held, generated, sourceFileIds, startedAt);
    } else if ('nothingToGenerate' in outcome) {
      await this.recorder.clear(claimed, held, startedAt);
    } else if (interruptedBy === DigestInterruption.SHUTDOWN) {
      // A deploy is not the meeting's fault: the claim goes back, uncounted.
      await this.recorder.release(claimed, held, spendOf(outcome), startedAt);
    } else {
      const { error } = outcome;
      const reason = failureReasonOf(error, interruptedBy, limitSeconds);

      this.logger.error(
        `Digest of meeting ${claimed.meetingId}: generation failed (${reason})`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.recorder.fail(
        claimed,
        held,
        { reason, model: MEETING_DIGEST_MODEL, costUsd: costOf(error) },
        startedAt,
      );
    }
  }
}
