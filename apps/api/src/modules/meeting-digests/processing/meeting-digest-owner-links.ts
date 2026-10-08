import type { Logger } from '@nestjs/common';
import type { QueryBus } from '@nestjs/cqrs';

import { FindMeetingMemberIdsQuery } from '../../meetings/queries/find-meeting-member-ids.query';
import { FindUsersByIdsQuery } from '../../user/queries/find-users-by-ids.query';
import type { UserDisplayName } from '../../user/queries/find-users-by-ids.query';
import type { MeetingDigestAnswer } from '../services/meeting-digest-answer';
import { NO_OWNER_LINKS, linkOwners } from '../services/meeting-digest-owner';
import type { DigestOwnerLinks } from '../services/meeting-digest-owner';

/**
 * The meeting's host and participants under their current display names — two questions
 * over the bus, because who is in a meeting is `meetings`' to answer and what a user is
 * called is `user`'s. A meeting that is gone has no members.
 */
export async function membersOf(queryBus: QueryBus, meetingId: string): Promise<UserDisplayName[]> {
  const memberIds = await queryBus.execute<FindMeetingMemberIdsQuery, string[] | null>(
    new FindMeetingMemberIdsQuery(meetingId),
  );

  if (memberIds === null) {
    return [];
  }

  return queryBus.execute<FindUsersByIdsQuery, UserDisplayName[]>(
    new FindUsersByIdsQuery(memberIds),
  );
}

/**
 * Which member of the meeting each owner an answer names is — decided here, after the
 * answer arrived, from names that never left for Anthropic.
 *
 * **It never rejects, and members that cannot be read link nobody.** That is the opposite
 * of what the worker does when it cannot check an answer's recordings, and deliberately:
 * storing those unchecked could serve a deleted recording's words, while an owner left as
 * the name that was spoken is the answer the PRD already prefers whenever a match is in
 * doubt. Failing the digest instead would throw away a generation that was paid for, to be
 * paid for again. The cause is logged; the names stay unlinked until the next generation.
 *
 * An answer that names nobody asks nothing.
 */
export async function ownerLinksOf(
  queryBus: QueryBus,
  logger: Logger,
  meetingId: string,
  answer: MeetingDigestAnswer,
): Promise<DigestOwnerLinks> {
  if (answer.actionItems.every(({ ownerName }) => ownerName === undefined)) {
    return NO_OWNER_LINKS;
  }

  try {
    return linkOwners(answer, await membersOf(queryBus, meetingId));
  } catch (error) {
    logger.error(
      `Digest of meeting ${meetingId}: its members could not be read, so every owner stays a name as spoken`,
      error instanceof Error ? error.stack : String(error),
    );

    return NO_OWNER_LINKS;
  }
}
