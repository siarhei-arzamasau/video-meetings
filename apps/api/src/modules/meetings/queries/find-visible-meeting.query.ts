/**
 * Resolves to the `Meeting` if `userId` hosts or attends it, else `null` — never a 404, per
 * the query rule: what a miss means belongs to the caller.
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
