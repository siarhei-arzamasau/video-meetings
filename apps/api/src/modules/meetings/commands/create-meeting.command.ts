/**
 * Primitives, not the DTO: a DTO is an HTTP-transport object carrying class-validator
 * decorators, and a handler that accepted one could not be exercised without building a
 * web-layer object.
 *
 * `hostId` comes from the guard rather than the body — the caller does not get to say who
 * hosts the meeting they are creating.
 */
export class CreateMeetingCommand {
  constructor(
    readonly hostId: string,
    readonly title: string,
    readonly scheduledAt: string,
    readonly participantIds: readonly string[],
  ) {}
}
