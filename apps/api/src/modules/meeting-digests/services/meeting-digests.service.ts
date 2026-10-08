import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';
import type { MeetingDigest } from '@repo/shared';

import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import type { TranscribedRecording } from '../../meeting-files/queries/find-transcribed-recordings.query';
import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
import type { VisibleMeeting } from '../../meetings/queries/find-visible-meeting.query';
import { FindUsersByIdsQuery } from '../../user/queries/find-users-by-ids.query';
import type { UserDisplayName } from '../../user/queries/find-users-by-ids.query';
import { isUnderWay } from './meeting-digest-action';
import { toMeetingDigest } from './meeting-digest.mapper';
import type { MeetingDigestRecord } from './meeting-digest.mapper';
import { MeetingDigestRepository } from './meeting-digest.repository';

/** The one 404 for a meeting the caller cannot see — the text every meeting route answers. */
export const MEETING_NOT_FOUND = 'Meeting not found';

const NO_OWNER_NAMES: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * The read side. A digest is visible to exactly who the meeting is — host and participants —
 * so the meeting is resolved first, over the bus, and a stranger, a guessed id, and a missing
 * meeting are one 404 that says nothing about whether a digest exists.
 *
 * **What is stored is served whatever the setting says.** `MEETING_DIGEST_ENABLED` decides
 * whether anything new is generated, and so one field of the answer and nothing else:
 * `availableAction`, which is absent while nothing can be asked for.
 */
@Injectable()
export class MeetingDigestsService {
  constructor(
    private readonly config: ConfigService,
    private readonly queryBus: QueryBus,
    private readonly digests: MeetingDigestRepository,
  ) {}

  /** The digest as one user is answered: the meeting has to be theirs to see. */
  async findOne(userId: string, meetingId: string): Promise<MeetingDigest> {
    await this.requireVisibleMeeting(userId, meetingId);

    return this.currentOf(meetingId);
  }

  /**
   * The meeting, if `userId` hosts or attends it — and otherwise the one 404, which is the
   * same for a stranger, a guessed id, and a meeting that does not exist.
   */
  async requireVisibleMeeting(userId: string, meetingId: string): Promise<VisibleMeeting> {
    const meeting = await this.queryBus.execute<FindVisibleMeetingQuery, VisibleMeeting | null>(
      new FindVisibleMeetingQuery(userId, meetingId),
    );

    if (meeting === null) {
      throw new NotFoundException(MEETING_NOT_FOUND);
    }

    return meeting;
  }

  /**
   * The digest as it stands, **for a caller that has already decided who is shown it**: the
   * route above, and the announcement of a change, which goes to streams the meeting's
   * members hold. One method for both is what makes an event the answer `GET` would give.
   *
   * The digest row first, the recordings second, and that order is deliberate: a recording
   * deleted between the two reads is already missing from the second, so its words are
   * withheld. The other way round, a delete in that gap would be served.
   */
  async currentOf(meetingId: string): Promise<MeetingDigest> {
    return this.describe(meetingId, await this.digests.findOf(meetingId));
  }

  /**
   * A digest row that has already been read, as the meeting's members are answered: the
   * second half of `currentOf`, and all of what the request route answers with — the row as
   * its own write left it, rather than as whoever claimed it a moment later did.
   *
   * The recordings are asked for only when something is decided by them: content, or —
   * with the setting on — whether a generation may be asked for. So a meeting with no
   * digest is one query fewer while the setting is off, and a digest that is queued or
   * generating with nothing stored under it is always. The owners' names likewise: one
   * query for all of them, and none for a digest that links nobody.
   *
   * **This is the one place a user's display name is read for somebody else**, and what
   * bounds it is that the ids come from the digest's own rows — members of this meeting,
   * matched by the worker — and never from a request.
   */
  async describe(meetingId: string, record: MeetingDigestRecord | null): Promise<MeetingDigest> {
    const generationEnabled = this.config.get<boolean>('MEETING_DIGEST_ENABLED', false);
    const stored = record !== null && record.summary !== null ? record : null;
    const decidedByRecordings =
      stored !== null || (generationEnabled && !isUnderWay(record?.status));
    const transcribed = decidedByRecordings ? await this.transcribedRecordingsOf(meetingId) : [];
    const ownerNames = stored === null ? NO_OWNER_NAMES : await this.ownerNamesOf(stored);

    return toMeetingDigest(
      meetingId,
      record,
      transcribed.map(({ id }) => id),
      ownerNames,
      generationEnabled,
    );
  }

  /** What each member an action item is linked to is called now, by user id. */
  private async ownerNamesOf({
    actionItems,
  }: MeetingDigestRecord): Promise<ReadonlyMap<string, string>> {
    const ownerIds = new Set(
      actionItems.flatMap(({ ownerId }) => (ownerId === null ? [] : [ownerId])),
    );

    if (ownerIds.size === 0) {
      return NO_OWNER_NAMES;
    }

    const owners = await this.queryBus.execute<FindUsersByIdsQuery, UserDisplayName[]>(
      new FindUsersByIdsQuery([...ownerIds]),
    );

    return new Map(owners.map(({ id, displayName }) => [id, displayName]));
  }

  /**
   * The meeting's transcribed recordings, in upload order — **for a caller that has already
   * decided who is asking**: the query carries no user and checks no visibility.
   */
  transcribedRecordingsOf(meetingId: string): Promise<TranscribedRecording[]> {
    return this.queryBus.execute<FindTranscribedRecordingsQuery, TranscribedRecording[]>(
      new FindTranscribedRecordingsQuery(meetingId),
    );
  }
}
