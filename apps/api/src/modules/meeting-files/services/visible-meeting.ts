import { NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { Meeting } from '@repo/shared';

import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';

/** The one 404 for a meeting the caller cannot see — the same text the meetings module uses. */
export const MEETING_NOT_FOUND = 'Meeting not found';
export const FILE_NOT_FOUND = 'File not found';

/**
 * Resolves the meeting every file route is scoped to, or throws the 404 that the meetings
 * module would. Dispatched over the bus rather than read from `MeetingsService`, so this
 * module never imports that one; a stranger, a guessed id, and a missing meeting are one
 * answer, before any file is touched.
 */
export async function requireVisibleMeeting(
  queryBus: QueryBus,
  userId: string,
  meetingId: string,
): Promise<Meeting> {
  const meeting = await queryBus.execute<FindVisibleMeetingQuery, Meeting | null>(
    new FindVisibleMeetingQuery(userId, meetingId),
  );

  if (meeting === null) {
    throw new NotFoundException(MEETING_NOT_FOUND);
  }

  return meeting;
}
