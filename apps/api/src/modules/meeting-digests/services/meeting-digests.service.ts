import { Injectable, NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { MeetingDigest } from '@repo/shared';

import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import type { TranscribedRecording } from '../../meeting-files/queries/find-transcribed-recordings.query';
import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
import type { VisibleMeeting } from '../../meetings/queries/find-visible-meeting.query';
import { toMeetingDigest } from './meeting-digest.mapper';
import { MeetingDigestRepository } from './meeting-digest.repository';

/** The one 404 for a meeting the caller cannot see — the text every meeting route answers. */
export const MEETING_NOT_FOUND = 'Meeting not found';

/**
 * The read side. A digest is visible to exactly who the meeting is — host and participants —
 * so the meeting is resolved first, over the bus, and a stranger, a guessed id, and a missing
 * meeting are one 404 that says nothing about whether a digest exists.
 *
 * **It does not ask whether the digest is switched on.** The setting decides whether
 * anything new is generated; what is stored stays readable with it off.
 */
@Injectable()
export class MeetingDigestsService {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly digests: MeetingDigestRepository,
  ) {}

  /**
   * The digest row first, the recordings second, and that order is deliberate: a recording
   * deleted between the two reads is already missing from the second, so its words are
   * withheld. The other way round, a delete in that gap would be served.
   *
   * The recordings are asked for only when there is content for them to decide about — which
   * for a meeting with no digest, every meeting while the setting is off, is one query fewer.
   */
  async findOne(userId: string, meetingId: string): Promise<MeetingDigest> {
    const meeting = await this.queryBus.execute<FindVisibleMeetingQuery, VisibleMeeting | null>(
      new FindVisibleMeetingQuery(userId, meetingId),
    );

    if (meeting === null) {
      throw new NotFoundException(MEETING_NOT_FOUND);
    }

    const record = await this.digests.findOf(meetingId);
    const hasContent = record !== null && record.summary !== null;
    const transcribed = hasContent ? await this.transcribedRecordingsOf(meetingId) : [];

    return toMeetingDigest(
      meetingId,
      record,
      transcribed.map(({ id }) => id),
    );
  }

  private transcribedRecordingsOf(meetingId: string): Promise<TranscribedRecording[]> {
    return this.queryBus.execute<FindTranscribedRecordingsQuery, TranscribedRecording[]>(
      new FindTranscribedRecordingsQuery(meetingId),
    );
  }
}
