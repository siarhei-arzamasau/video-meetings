/**
 * Asks for a meeting's digest to be generated now: Generate for recordings that were never
 * digested, Retry for a digest that failed. One command for both — what differs is the
 * digest it finds, not what is asked.
 */
export class RequestMeetingDigestCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
  ) {}
}
