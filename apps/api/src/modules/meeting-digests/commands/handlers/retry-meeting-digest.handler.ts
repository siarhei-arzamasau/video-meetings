import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import type { MeetingDigest } from '@repo/shared';

import type { TranscribedRecording } from '../../../meeting-files/queries/find-transcribed-recordings.query';
import { DigestRequestRefusal } from '../../services/meeting-digest-action';
import { MeetingDigestAnnouncer } from '../../services/meeting-digest-announcer';
import { MeetingDigestRepository } from '../../services/meeting-digest.repository';
import { MEETING_NOT_FOUND, MeetingDigestsService } from '../../services/meeting-digests.service';
import { RetryMeetingDigestCommand } from '../retry-meeting-digest.command';

export const DIGEST_SWITCHED_OFF_MESSAGE = 'Meeting digests are switched off';

/** The 409 for each way a digest refuses a retry. Not copy a page shows: it refetches. */
export const DIGEST_REFUSAL_MESSAGES: Record<DigestRequestRefusal, string> = {
  [DigestRequestRefusal.NO_RECORDING]:
    'The meeting has no transcribed recording to generate a digest from',
  [DigestRequestRefusal.UNDER_WAY]: 'A digest is already queued or being generated',
  [DigestRequestRefusal.CURRENT]: 'The digest already covers every transcribed recording',
  [DigestRequestRefusal.OTHER_KIND]: 'The digest has not failed, so there is nothing to retry',
};

/**
 * Retry: the one request for a digest that a person makes, and the one caller of `FAILED →
 * QUEUED` that no recording caused. Everything else that queues a digest is a recording
 * being transcribed or deleted, or the boot's catch-up.
 *
 * Who may ask: the host, or the uploader of one of the meeting's transcribed recordings —
 * the people who may already retry a transcription there — and anyone else gets the 404 a
 * guessed id gets rather than a 403, another participant of the meeting included.
 *
 * **The setting is asked about after the gate and before the write.** After, so that the
 * 409 it answers is only ever given to someone who could have asked: whether a deployment
 * generates digests is not a stranger's to learn. Before, because unlike a transcription's
 * retry there is nothing useful in queueing for the setting's return — a request made with
 * it off would be a paid request made the day somebody switches it on, by nobody.
 *
 * The request itself is `MeetingDigestRepository.requestRetry`: conditional on the digest
 * as it stands under its lock, by the rule the read reports `availableAction` with, so a
 * control that was shown and a request that is accepted cannot disagree for longer than
 * the page takes to hear of a change. A refusal is the 409 and writes nothing — a digest
 * that is owed and has not failed included, which is the catch-up's to ask for and nobody
 * else's. An accepted request is every other request's write — `QUEUED`, the claim count
 * back at 0, the reason gone — and the worker claims the row like any other; nothing here
 * calls Claude.
 */
@CommandHandler(RetryMeetingDigestCommand)
export class RetryMeetingDigestHandler implements ICommandHandler<
  RetryMeetingDigestCommand,
  MeetingDigest
> {
  private readonly logger = new Logger(RetryMeetingDigestHandler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly digests: MeetingDigestsService,
    private readonly repository: MeetingDigestRepository,
    private readonly announcer: MeetingDigestAnnouncer,
  ) {}

  async execute({ userId, meetingId }: RetryMeetingDigestCommand): Promise<MeetingDigest> {
    const recordings = await this.requireRequestableMeeting(userId, meetingId);

    if (!this.config.get<boolean>('MEETING_DIGEST_ENABLED', false)) {
      throw new ConflictException(DIGEST_SWITCHED_OFF_MESSAGE);
    }

    const request = await this.repository.requestRetry(
      meetingId,
      recordings.map(({ id }) => id),
    );

    if (!request.allowed) {
      throw new ConflictException(DIGEST_REFUSAL_MESSAGES[request.refusal]);
    }

    this.logger.log(`Digest of meeting ${meetingId}: retry requested by user ${userId}`);

    // After the write reported that it was made, never before it: a refusal above changed
    // nothing and announces nothing. And before the answer is built, so that a read that
    // fails below costs the caller a response and no open page its event.
    await this.announcer.announce(meetingId);

    // The row as this write left it rather than as it is by now: a worker may have claimed
    // it already, and answering `generating` would say the request did something it did not.
    // The claim's own event carries a higher version, and a page keeps the higher of two.
    return this.digests.describe(meetingId, request.record);
  }

  /**
   * The gate, in the order its answers are owed: a meeting the caller cannot see, then a
   * caller who neither hosts it nor uploaded one of its transcribed recordings. Answers
   * with those recordings, which the request is then decided against.
   */
  private async requireRequestableMeeting(
    userId: string,
    meetingId: string,
  ): Promise<TranscribedRecording[]> {
    const meeting = await this.digests.requireVisibleMeeting(userId, meetingId);
    const recordings = await this.digests.transcribedRecordingsOf(meetingId);
    const uploadedOne = recordings.some(({ uploaderId }) => uploaderId === userId);

    if (userId !== meeting.hostId && !uploadedOne) {
      throw new NotFoundException(MEETING_NOT_FOUND);
    }

    return recordings;
  }
}
