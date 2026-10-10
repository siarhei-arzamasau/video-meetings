import {
  MEETING_DIGEST_FAILED_MESSAGE,
  MEETING_DIGEST_TOO_LONG_MESSAGE,
  meetingDigestTimeLimitMessage,
} from '@repo/shared';

import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
import { DigestInterruption } from './meeting-digest-run';

/**
 * The sentence a failed digest shows. Chosen from what ended the generation — the worker
 * owns the time limit, and the generator says when the transcripts were too long — and never
 * from an error's own message, which quotes the SDK and Anthropic and is for the log.
 *
 * The time limit is asked about first: a generation it hung up on rejects with whatever the
 * SDK makes of being hung up on, and that error says nothing a user could act on.
 */
export function failureReasonOf(
  error: unknown,
  interruptedBy: DigestInterruption | null,
  limitSeconds: number,
): string {
  if (interruptedBy === DigestInterruption.TIME_LIMIT) {
    return meetingDigestTimeLimitMessage(limitSeconds);
  }

  const tooLong =
    error instanceof MeetingDigestError &&
    error.failure === MeetingDigestFailure.TRANSCRIPTS_TOO_LONG;

  return tooLong ? MEETING_DIGEST_TOO_LONG_MESSAGE : MEETING_DIGEST_FAILED_MESSAGE;
}
