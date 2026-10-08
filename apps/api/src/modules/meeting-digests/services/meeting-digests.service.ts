import { Injectable, NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { MeetingDigest } from '@repo/shared';

import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import type { TranscribedRecording } from '../../meeting-files/queries/find-transcribed-recordings.query';
import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
import type { VisibleMeeting } from '../../meetings/queries/find-visible-meeting.query';
import { FindUsersByIdsQuery } from '../../user/queries/find-users-by-ids.query';
import type { UserDisplayName } from '../../user/queries/find-users-by-ids.query';
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
 * **It does not ask whether the digest is switched on.** The setting decides whether
 * anything new is generated; what is stored stays readable with it off.
 */
@Injectable()
export class MeetingDigestsService {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly digests: MeetingDigestRepository,
  ) {}

  /** The digest as one user is answered: the meeting has to be theirs to see. */
  async findOne(userId: string, meetingId: string): Promise<MeetingDigest> {
    const meeting = await this.queryBus.execute<FindVisibleMeetingQuery, VisibleMeeting | null>(
      new FindVisibleMeetingQuery(userId, meetingId),
    );

    if (meeting === null) {
      throw new NotFoundException(MEETING_NOT_FOUND);
    }

    return this.currentOf(meetingId);
  }

  /**
   * The digest as it stands, **for a caller that has already decided who is shown it**: the
   * route above, and the announcement of a change, which goes to streams the meeting's
   * members hold. One method for both is what makes an event the answer `GET` would give.
   *
   * The digest row first, the recordings second, and that order is deliberate: a recording
   * deleted between the two reads is already missing from the second, so its words are
   * withheld. The other way round, a delete in that gap would be served.
   *
   * The recordings are asked for only when there is content for them to decide about — which
   * for a meeting with no digest, every meeting while the setting is off, is one query fewer.
   * The owners' names likewise: one query for all of them, and none for a digest that links
   * nobody.
   *
   * **This is the one place a user's display name is read for somebody else**, and what
   * bounds it is that the ids come from the digest's own rows — members of this meeting,
   * matched by the worker — and never from a request.
   */
  async currentOf(meetingId: string): Promise<MeetingDigest> {
    const record = await this.digests.findOf(meetingId);
    const stored = record !== null && record.summary !== null ? record : null;
    const transcribed = stored === null ? [] : await this.transcribedRecordingsOf(meetingId);
    const ownerNames = stored === null ? NO_OWNER_NAMES : await this.ownerNamesOf(stored);

    return toMeetingDigest(
      meetingId,
      record,
      transcribed.map(({ id }) => id),
      ownerNames,
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

  private transcribedRecordingsOf(meetingId: string): Promise<TranscribedRecording[]> {
    return this.queryBus.execute<FindTranscribedRecordingsQuery, TranscribedRecording[]>(
      new FindTranscribedRecordingsQuery(meetingId),
    );
  }
}
