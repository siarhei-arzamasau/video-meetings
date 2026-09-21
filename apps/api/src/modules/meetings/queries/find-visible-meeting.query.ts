import type { Meeting } from '@repo/shared';

/**
 * What a caller across the boundary decides with: that the meeting exists for this user, and
 * who hosts it — the one field a file route reads, to let the host manage anyone's file.
 */
export type VisibleMeeting = Pick<Meeting, 'id' | 'hostId'>;

/**
 * Resolves to the meeting's `VisibleMeeting` if `userId` hosts or attends it, else `null` —
 * never a 404, per the query rule: what a miss means belongs to the caller.
 *
 * This is the first read to cross out of the meetings module. The meeting-files module
 * dispatches it for every route so a meeting the caller cannot see answers 404 before any
 * file is touched, without that module importing this one.
 */
export class FindVisibleMeetingQuery {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
  ) {}
}
