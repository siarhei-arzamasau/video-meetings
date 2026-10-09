/** What became of a revision. Nothing here is copy for a user: the caller words its own. */
export enum MeetingDigestRevisionOutcome {
  /** The summary and the decisions are stored, and the meeting's open pages were told. */
  REVISED = 'REVISED',
  /** The meeting has no stored digest to revise. Nothing was written. */
  NO_DIGEST = 'NO_DIGEST',
  /** The summary or a decision is blank or past the digest's bounds. Nothing was written. */
  UNFIT = 'UNFIT',
}

/**
 * Puts a summary and decisions in place of the ones a meeting's stored digest has, by
 * whoever was given the means to — an agent's tool, so far. It revises a digest; it does
 * not make one.
 *
 * **No user, and so no gate.** Whether the caller may touch this meeting was decided by
 * whoever handed it the command, as it is for the worker.
 */
export class ReviseMeetingDigestCommand {
  constructor(
    readonly meetingId: string,
    readonly summary: string,
    readonly decisions: ReadonlyArray<string>,
  ) {}
}
