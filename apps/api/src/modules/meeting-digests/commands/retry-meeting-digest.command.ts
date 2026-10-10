/**
 * Asks for a meeting's failed digest to be generated again: Retry, the one request for a
 * digest that a person makes. A digest that has not failed is not this command's to ask for.
 */
export class RetryMeetingDigestCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
  ) {}
}
