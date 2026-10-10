import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';

import { describeError } from '../../../common/error-message';
import { FindTranscribedRecordingsByMeetingQuery } from '../../meeting-files/queries/find-transcribed-recordings-by-meeting.query';
import type { MeetingTranscribedRecordings } from '../../meeting-files/queries/find-transcribed-recordings-by-meeting.query';
import { DigestRequestKind, requestabilityFor } from '../services/meeting-digest-action';
import { MeetingDigestAnnouncer } from '../services/meeting-digest-announcer';
import { MeetingDigestRepository } from '../services/meeting-digest.repository';
import { PendingDigestRequests } from '../services/pending-digest-requests';
import { transcribedIdsOf } from './meeting-digest-recordings';

/** The string token this is also registered under, so an e2e spec can reach `run()`. */
export const MEETING_DIGEST_CATCH_UP = 'MEETING_DIGEST_CATCH_UP';

/**
 * Asks, once at boot, for every digest a meeting is owed and nothing else will ask for.
 *
 * While a process runs, the one thing that asks for a digest is a recording being
 * transcribed. A meeting is left owed one all the same: its recordings were transcribed
 * while `MEETING_DIGEST_ENABLED` was off, or before there was a digest at all; the request
 * that follows a transcription was lost with its process, or failed; a delete emptied the
 * digest with the setting off, or was never followed. Each of those used to wait for
 * somebody to ask by hand. The next boot with the setting on now finds them — and a change
 * of the setting is a boot.
 *
 * **So the first boot with the setting on sends Anthropic the transcripts of every meeting
 * that has a recording and no current digest, with nobody asking** — one paid generation
 * each. That was the owner's decision, on 2026-10-10, and it is why the count is logged
 * before the first is asked for, and again with how many were.
 *
 * **A failed digest is not one of them.** Its way forward is a person's Retry: asking again
 * at every boot would be the automatic retry of a paid request that nothing here makes.
 *
 * Two looks, and only the second decides:
 *
 * - **Every meeting's recordings beside every digest's standing, to skip by.** Two
 *   statements say which meetings might be owed a digest, so a boot with nothing owed costs
 *   those two and no more.
 * - **Each of those again, one at a time**: its recordings as they are now, and the request
 *   decided under the row's lock by `requestGenerationAs`. The first look is stale by a
 *   meeting's turn — a recording deleted or transcribed meanwhile would have a digest that
 *   is current asked for again — and the lock is what keeps a second replica booting beside
 *   this one from asking twice.
 *
 * **Not awaited by the boot**: `listen` must not wait behind a backlog. What holds it is
 * `PendingDigestRequests`, as it holds the requests an event starts — for shutdown, which
 * waits for the meeting in hand and no further, and for the tests' `drain()`.
 */
@Injectable()
export class MeetingDigestCatchUp implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MeetingDigestCatchUp.name);
  /** Set on shutdown: the meeting in hand is finished, and no other is started. */
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly queryBus: QueryBus,
    private readonly digests: MeetingDigestRepository,
    private readonly pending: PendingDigestRequests,
    private readonly announcer: MeetingDigestAnnouncer,
  ) {}

  /** Only where the digest worker polls: a process that generates nothing queues nothing. */
  onApplicationBootstrap(): void {
    const polls = this.config.get<boolean>('MEETING_FILES_WORKER_ENABLED', true);

    if (polls && this.isSwitchedOn()) {
      this.pending.track(this.catchUpAtBoot());
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
  }

  /**
   * Asks for every digest that is owed, and resolves to how many it asked for. Never
   * rejects: what cannot be read or written is logged, and waits for the next boot. With
   * the setting off it asks for nothing — and stops asking the moment it is switched off.
   */
  async run(): Promise<number> {
    if (!this.isSwitchedOn()) {
      return 0;
    }

    const meetingIds = await this.findMeetingsToAskAbout();

    if (meetingIds === null) {
      return 0;
    }

    // Said before anything is asked for, and not only after: each is a paid request nobody
    // made, and the count is what somebody watching a first boot can still act on.
    this.logger.log(`Digest catch-up: ${String(meetingIds.length)} meetings look owed a digest`);

    if (meetingIds.length === 0) {
      return 0;
    }

    const queued = await this.catchUpFrom(meetingIds, 0, 0);

    this.logger.log(`Digest catch-up: asked for ${String(queued)} of ${String(meetingIds.length)}`);

    return queued;
  }

  /**
   * The meetings from `index` on, one after another, and resolves to how many were asked
   * for in all. In turn rather than side by side: each is a transaction that locks a row,
   * and a backlog asked about at once would be the connection pool, emptied at boot.
   */
  private async catchUpFrom(
    meetingIds: ReadonlyArray<string>,
    index: number,
    queued: number,
  ): Promise<number> {
    const meetingId = meetingIds[index];

    if (meetingId === undefined || this.stopping || !this.isSwitchedOn()) {
      return queued;
    }

    const asked = await this.catchUp(meetingId);

    return this.catchUpFrom(meetingIds, index + 1, queued + (asked ? 1 : 0));
  }

  private async catchUpAtBoot(): Promise<void> {
    await this.run();
  }

  private isSwitchedOn(): boolean {
    return this.config.get<boolean>('MEETING_DIGEST_ENABLED', false);
  }

  /**
   * The first look: the meetings whose digest, as one statement read it, is owed — or
   * `null` when the look could not be taken, which is logged here and is not "none".
   */
  private async findMeetingsToAskAbout(): Promise<string[] | null> {
    try {
      const standings = await this.digests.findStandings();
      const meetings = await this.queryBus.execute<
        FindTranscribedRecordingsByMeetingQuery,
        MeetingTranscribedRecordings[]
      >(new FindTranscribedRecordingsByMeetingQuery());

      return meetings
        .filter(({ meetingId, fileIds }) => {
          const standing = standings.get(meetingId) ?? null;

          return requestabilityFor(DigestRequestKind.CATCH_UP, standing, new Set(fileIds)).allowed;
        })
        .map(({ meetingId }) => meetingId);
    } catch (error) {
      this.logger.error(
        'Digest catch-up: the meetings owed a digest could not be read; nothing is queued',
        describeError(error),
      );

      return null;
    }
  }

  /** The second look, for one meeting: resolves to whether a generation was asked for. */
  private async catchUp(meetingId: string): Promise<boolean> {
    try {
      const transcribedFileIds = await transcribedIdsOf(this.queryBus, meetingId);
      const queued = await this.digests.requestCatchUp(meetingId, transcribedFileIds);

      if (queued) {
        this.logger.log(`Digest of meeting ${meetingId}: requested, to catch up`);
        await this.announcer.announce(meetingId);
      }

      return queued;
    } catch (error) {
      this.logger.error(
        `Digest of meeting ${meetingId}: the catch-up's request failed; nothing is queued`,
        describeError(error),
      );

      return false;
    }
  }
}
