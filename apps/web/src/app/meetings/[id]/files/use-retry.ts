'use client';

import type { MeetingFile } from '@repo/shared';
import { useState } from 'react';

import { ApiError, retryMeetingFile, retryMeetingFileTranscription } from '@/lib/api-client';
import type { RetryTarget } from '@/lib/meeting-file-retry';

const FAILED_MESSAGE = 'The retry failed. Try again.';

/** The request behind each target. Both answer with the file as the retry left it. */
const REQUESTS: Record<RetryTarget, typeof retryMeetingFile> = {
  file: retryMeetingFile,
  transcription: retryMeetingFileTranscription,
};

interface RetryOutcomes {
  /** The API took the retry. What the row is now is the list's to say: see `useRetry`. */
  onRetried(): void;
  /** Someone else moved it meanwhile: refetch rather than guess what it is now. */
  onStale(): void;
  onUnauthorized(): void;
}

export interface Retry {
  /** Why the last attempt failed, for the row to show inline. `null` when nothing did. */
  error: string | null;
  isRetrying: boolean;
  retry(target: RetryTarget): void;
  dismiss(): void;
}

/**
 * A row's Retry, for whichever of the two failed: the file, back through the pipeline, or
 * only its transcription, back to the queue. **One hook and one set of outcomes for both**,
 * because the API gates and answers the two alike and a second copy could only drift from the
 * first.
 *
 * It needs no state machine of its own, and **it does not put the API's answer on the row.**
 * The answer is the file as the retry left it — `uploaded`, or `ready` with its transcription
 * `queued` — and it travels on a connection of its own, so by the time it lands the stream may
 * already have said that, then a worker's claim, then the next failure. Written over the row it
 * would show a file that has failed again as queued, with no Retry, and no event would follow
 * to correct it. So the answer is only a cue: `onRetried` refetches the list, which is what
 * can be put in order against the stream. The stream moves the row on from there; with no
 * stream the fallback poll does, which runs for exactly those two states — and for a refetch
 * that failed, so a lost one cannot leave a retried row reading "failed".
 */
export function useRetry(
  token: string,
  { id, meetingId }: Pick<MeetingFile, 'id' | 'meetingId'>,
  { onRetried, onStale, onUnauthorized }: RetryOutcomes,
): Retry {
  const [error, setError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  async function send(target: RetryTarget): Promise<void> {
    setIsRetrying(true);
    setError(null);

    try {
      await REQUESTS[target](token, meetingId, id);
      onRetried();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        onUnauthorized();

        return;
      }

      // 409: it is no longer failed, because someone else retried it or a worker finished
      // it. Nothing to report — refetch and let the list show whatever it really is.
      if (failure instanceof ApiError && failure.status === 409) {
        onStale();

        return;
      }

      setError(failure instanceof ApiError ? failure.message : FAILED_MESSAGE);
    } finally {
      setIsRetrying(false);
    }
  }

  return {
    error,
    isRetrying,
    retry: (target) => {
      void send(target);
    },
    dismiss: () => setError(null),
  };
}
