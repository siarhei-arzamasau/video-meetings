/** Why a digest was not generated, where the reason is this module's to decide. */
export enum MeetingDigestFailure {
  /**
   * The transcripts are more than one request can carry — past this module's own cap, in
   * which case nothing was sent, or past what the model would read, in which case Claude
   * said so. One failure for both: sending again ends the same way, and a digest of part of
   * a meeting is not offered in its place.
   */
  TRANSCRIPTS_TOO_LONG = 'TRANSCRIPTS_TOO_LONG',
  /** Claude answered, and the answer is not a digest. Nothing of it is kept. */
  INVALID_ANSWER = 'INVALID_ANSWER',
  /**
   * Claude answered, and whether the recordings it read are all still there could not be
   * established. Nothing of it is kept: an answer is stored only once that is known.
   */
  SOURCES_UNCHECKED = 'SOURCES_UNCHECKED',
}

export interface MeetingDigestErrorOptions extends ErrorOptions {
  /** What the call cost, when one was made and reported it. */
  costUsd?: number;
}

/**
 * What `MeetingDigestGenerator` throws for a failure it decided itself, and the worker for
 * the one it decides after an answer. Everything else is let through as the
 * `ClaudeAgentError` it was — a refused token, an unreachable API, a call that was hung up on.
 *
 * **The message is for a log, never for a user**, and it never quotes a transcript or an
 * answer: what a failed digest shows is fixed copy chosen by whoever records the failure.
 */
export class MeetingDigestError extends Error {
  readonly costUsd?: number;

  constructor(
    readonly failure: MeetingDigestFailure,
    message: string,
    options?: MeetingDigestErrorOptions,
  ) {
    super(message, options);
    this.name = MeetingDigestError.name;
    this.costUsd = options?.costUsd;
  }
}
