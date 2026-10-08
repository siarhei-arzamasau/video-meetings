import type { Logger } from '@nestjs/common';
import { MEETING_DIGEST_FAILED_MESSAGE } from '@repo/shared';

import type { ClaudeModel } from '../../claude-agent/claude-agent.constants';
import type { HeldDigest } from '../services/meeting-digest-claim-writes';
import type {
  ClaimedDigest,
  MeetingDigestClaimRepository,
} from '../services/meeting-digest-claim.repository';
import type { GeneratedMeetingDigest } from '../services/meeting-digest-generator';
import { DigestStatus } from '../services/meeting-digest-status';
import { usd } from './meeting-digest-spend';
import type { GenerationSpend } from './meeting-digest-spend';

const { QUEUED, GENERATING } = DigestStatus;

/** What a failed generation is logged with: what it cost, when a call was made and said so. */
export interface FailedGeneration {
  /** Fixed copy the worker chose. The cause was logged where it was caught. */
  reason: string;
  /** The model that was asked: a failure has no answer to name the one that replied. */
  model: ClaudeModel;
  costUsd?: number;
}

/**
 * The writing half of the digest worker: how a claim ended, put on the row and logged.
 * Constructed by the worker, as the transcription worker's recorder is.
 *
 * Every write is the claim repository's conditional one — the row still `GENERATING`, the
 * lease still the one held — and one that changed nothing lost its claim: to another worker,
 * or to the delete of the meeting's last recording. Whatever was produced is discarded, and
 * the log says so.
 *
 * **Every write that landed is announced, after it and before the next thing is done** —
 * `announce` is `MeetingDigestAnnouncer`'s, which reads the digest and publishes it. Awaited
 * so that "generating" is what the read finds: started and left behind, it would as often
 * find the answer that a quick generation had already stored. A write that lost its claim
 * announces nothing — it changed nothing, and whoever took the row announces their own.
 *
 * **Every generation is logged with its duration, its model, and what it cost**, whether it
 * ended in a digest or not: each is a paid request, and the log is the only place the cost
 * is kept. No row holds it and no response carries it.
 */
export class DigestOutcomeRecorder {
  constructor(
    private readonly claims: MeetingDigestClaimRepository,
    private readonly logger: Logger,
    private readonly announce: (meetingId: string) => Promise<void>,
  ) {}

  /** `claimNext` committed this edge itself; the claim returning a row is its "one row changed". */
  async claimed(claimed: ClaimedDigest): Promise<void> {
    this.logger.log(
      `Digest of meeting ${claimed.meetingId}: ${claimed.previousStatus} -> ${GENERATING}, claim ${String(claimed.attempts)}`,
    );
    await this.announce(claimed.meetingId);
  }

  /**
   * The answer and its sources, in one transaction with the write that ends the claim.
   *
   * An answer that cannot be stored at all — text PostgreSQL will not hold, a constraint
   * nobody foresaw — is a failed digest, and is recorded as one in the generic sentence. Left
   * to escape, it kept the row `GENERATING` until the lease lapsed and the meeting was sent
   * to Claude again, and paid for again, twice more, to end as "repeated attempts".
   *
   * Answers whether the answer is now stored — under `READY` or under `QUEUED` — which is
   * what the caller owes its recordings a second look for.
   */
  async complete(
    claimed: ClaimedDigest,
    lease: Date,
    generated: GeneratedMeetingDigest,
    sourceFileIds: ReadonlyArray<string>,
    startedAt: number,
  ): Promise<boolean> {
    const { answer, model, costUsd, inputTokens, outputTokens } = generated;
    const held = heldOf(claimed, lease);

    this.logger.log(
      `Digest of meeting ${claimed.meetingId}: generated from ${String(sourceFileIds.length)} recording(s) by ${model} in ${String(Date.now() - startedAt)}ms, ${String(inputTokens)} tokens in and ${String(outputTokens)} out, ${usd(costUsd)}`,
    );

    try {
      const settledAs = await this.claims.complete(held, { answer, sourceFileIds });

      await this.settled(claimed, settledAs, 'stored', startedAt);

      return settledAs !== null;
    } catch (error) {
      this.logger.error(
        `Digest of meeting ${claimed.meetingId}: the digest could not be stored`,
        error instanceof Error ? error.stack : String(error),
      );

      const settledAs = await this.claims.fail(held, MEETING_DIGEST_FAILED_MESSAGE);

      await this.settled(claimed, settledAs, 'recorded as failed', startedAt);

      return false;
    }
  }

  /**
   * An answer one of whose recordings was deleted while Claude wrote it. Nothing of it is
   * stored, and the claim goes back as a shutdown's does — queued and uncounted: the
   * generation did not fail, it was overtaken, and the one that follows reads what is left.
   * It was paid for all the same, so it is logged like one that was kept.
   */
  async discard(
    claimed: ClaimedDigest,
    lease: Date,
    { model, costUsd }: GeneratedMeetingDigest,
    startedAt: number,
  ): Promise<void> {
    this.logger.warn(
      `Digest of meeting ${claimed.meetingId}: generated by ${model} in ${String(Date.now() - startedAt)}ms, ${usd(costUsd)}, and discarded — a recording it was built from was deleted meanwhile`,
    );

    const released = await this.claims.release(claimed.id, lease);

    await this.settled(claimed, released ? QUEUED : null, 'handed back', startedAt);
  }

  async fail(
    claimed: ClaimedDigest,
    lease: Date,
    { reason, model, costUsd }: FailedGeneration,
    startedAt: number,
  ): Promise<void> {
    this.logger.error(
      `Digest of meeting ${claimed.meetingId}: no digest from ${model} after ${String(Date.now() - startedAt)}ms (${reason}), ${costUsd === undefined ? 'no cost reported' : usd(costUsd)}`,
    );

    const settledAs = await this.claims.fail(heldOf(claimed, lease), reason);

    await this.settled(claimed, settledAs, 'recorded as failed', startedAt);
  }

  /**
   * Shutdown's way out: the claim goes back uncounted, for whichever process claims it next.
   * A call that was hung up on rarely reports a cost; one that answered just too late does.
   */
  async release(
    claimed: ClaimedDigest,
    lease: Date,
    spent: GenerationSpend | null,
    startedAt: number,
  ): Promise<void> {
    if (spent !== null) {
      this.logger.log(
        `Digest of meeting ${claimed.meetingId}: a call to ${spent.model} was hung up on for shutdown after ${String(Date.now() - startedAt)}ms, ${usd(spent.costUsd)}`,
      );
    }

    const released = await this.claims.release(claimed.id, lease);

    await this.settled(claimed, released ? QUEUED : null, 'released', startedAt);
  }

  /**
   * No transcribed recording was left: the meeting has no digest, and nothing is queued —
   * unless one was transcribed after the claim looked, whose request leaves the row queued.
   */
  async clear(claimed: ClaimedDigest, lease: Date, startedAt: number): Promise<void> {
    const clearedAs = await this.claims.clear(heldOf(claimed, lease));

    if (clearedAs === null) {
      this.lost(claimed, 'cleared');

      return;
    }

    const leftAs = clearedAs === QUEUED ? `${QUEUED}, asked for again meanwhile` : 'none';

    this.logger.log(
      `Digest of meeting ${claimed.meetingId}: ${GENERATING} -> ${leftAs}; no transcribed recording was left, in ${String(Date.now() - startedAt)}ms`,
    );
    await this.announce(claimed.meetingId);
  }

  /**
   * A renewal found the claim gone, so there is nothing to write. Whatever the call produced
   * is discarded — and was paid for all the same, which is why its cost is logged here too.
   */
  abandoned(claimed: ClaimedDigest, spent: GenerationSpend | null, startedAt: number): void {
    if (spent !== null) {
      this.logger.warn(
        `Digest of meeting ${claimed.meetingId}: a call to ${spent.model} ended after ${String(Date.now() - startedAt)}ms under a claim that was lost, ${usd(spent.costUsd)}`,
      );
    }

    this.lost(claimed, 'finished');
  }

  /**
   * The claim was gone by the time something was written under it: its lease lapsed and
   * another worker took the row, or the meeting's last recording was deleted and the row has
   * no status to generate for.
   */
  private lost(claimed: ClaimedDigest, what: string): void {
    this.logger.warn(
      `Digest of meeting ${claimed.meetingId}: not ${what} — the claim was no longer this worker's (reclaimed past its lease, or the last recording deleted); result discarded`,
    );
  }

  private async settled(
    claimed: ClaimedDigest,
    settledAs: DigestStatus | null,
    what: string,
    startedAt: number,
  ): Promise<void> {
    if (settledAs === null) {
      this.lost(claimed, what);

      return;
    }

    this.logger.log(
      `Digest of meeting ${claimed.meetingId}: ${GENERATING} -> ${settledAs} in ${String(Date.now() - startedAt)}ms`,
    );
    await this.announce(claimed.meetingId);
  }
}

function heldOf(claimed: ClaimedDigest, lease: Date): HeldDigest {
  return { id: claimed.id, lease, requestedRevision: claimed.requestedRevision };
}
