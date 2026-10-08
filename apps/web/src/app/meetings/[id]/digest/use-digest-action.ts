'use client';

import type { Meeting, MeetingDigest, MeetingDigestAction, MeetingFile, User } from '@repo/shared';
import { useState } from 'react';

import { ApiError, requestMeetingDigest } from '@/lib/api-client';
import { offeredDigestAction } from '@/lib/meeting-digest-action';
import type { FilesList } from '../files/use-files-snapshot';

const FAILED_MESSAGE = 'The request failed. Try again.';

/** One array for every render without a list, so nothing downstream sees it change. */
const NO_FILES: ReadonlyArray<MeetingFile> = [];

interface DigestRequestOutcomes {
  /** The API took the request: its answer is the digest as the request left it. */
  onAccepted(digest: MeetingDigest): void;
  /** There was nothing to ask for any more: fetch the digest rather than guess what it is. */
  onStale(): void;
  onUnauthorized(): void;
}

interface DigestActionOptions extends DigestRequestOutcomes {
  token: string;
  meeting: Pick<Meeting, 'id' | 'hostId'>;
  user: Pick<User, 'id'>;
  digest: MeetingDigest | null;
  /** The page's own files list: who uploaded a transcribed recording is read from it. */
  list: FilesList;
}

export interface DigestActionControl {
  /** What this reader may ask for now — the control is drawn for nothing else. */
  offered: MeetingDigestAction | null;
  /** Why the last request failed, for the section to show inline. `null` when nothing did. */
  error: string | null;
  isRequesting: boolean;
  request(): void;
  dismiss(): void;
}

/** A request that failed, and the digest whose control was pressed to send it. */
interface DigestRequestFailure {
  message: string;
  version: MeetingDigest['version'];
}

interface DigestRequest {
  failure: DigestRequestFailure | null;
  isRequesting: boolean;
  /** Asks for a digest; `version` is the digest the reader was looking at when they did. */
  send(version: MeetingDigest['version']): Promise<void>;
  dismiss(): void;
}

/**
 * The request and what becomes of each of its answers. A 401 is the gate's, a 409 is a cue
 * to fetch, and only what is left is a failure for the section to show.
 */
function useDigestRequest(
  token: string,
  meetingId: Meeting['id'],
  { onAccepted, onStale, onUnauthorized }: DigestRequestOutcomes,
): DigestRequest {
  const [failure, setFailure] = useState<DigestRequestFailure | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);

  async function send(version: MeetingDigest['version']): Promise<void> {
    setIsRequesting(true);
    setFailure(null);

    try {
      onAccepted(await requestMeetingDigest(token, meetingId));
    } catch (thrown) {
      if (thrown instanceof ApiError && thrown.status === 401) {
        onUnauthorized();

        return;
      }

      if (thrown instanceof ApiError && thrown.status === 409) {
        onStale();

        return;
      }

      setFailure({
        message: thrown instanceof ApiError ? thrown.message : FAILED_MESSAGE,
        version,
      });
    } finally {
      setIsRequesting(false);
    }
  }

  return { failure, isRequesting, send, dismiss: () => setFailure(null) };
}

/**
 * The digest's one control — "Generate digest" or "Retry", which are one request — for the
 * reader it is offered to, with the outcomes a file's Retry has (`useRetry`).
 *
 * **Who is offered it is decided here and nowhere else on the page**, by
 * `offeredDigestAction`: the digest says what may be asked for, and the files list says
 * whether this reader is one of the two who may ask.
 *
 * **Where it differs from a file's Retry is the answer, and the difference is the version.**
 * A row's retry refetches the list and never writes the API's answer over the row, because a
 * file carries nothing to put that answer in order against the stream. A digest does: the
 * answer is handed to `onAccepted` and kept only if it is not older than what the stream has
 * already brought. So a request that was overtaken by a claim and a second failure leaves
 * the failure on the page, and one that was not shows "Digest queued" with no fetch at all —
 * which, with no stream, is also what arms the digest's fallback poll.
 *
 * **A 409 says only that there is nothing to ask for any more** — somebody else asked, the
 * last recording went, the setting is off — so its sentence is never shown: the digest is
 * fetched again and the page shows that. Anything else is shown inline with Dismiss.
 *
 * **An error is about one press, and is shown only beside the control that was pressed** —
 * while that control is offered and the digest held is still the version it was pressed on.
 * Kept any longer it comes back beside the next one: "The request failed" next to a Retry
 * nobody has pressed. **It is worked out on every render rather than cleared when the control
 * is seen to go**, because the page does not always see it go. A failure can land after the
 * stream has already taken the control away — the API took the request and its answer was
 * lost on the way back — and one chunk of the stream can carry a request, a claim and a
 * second failure, which is one render that begins and ends with a Retry on it.
 */
export function useDigestAction({
  token,
  meeting,
  user,
  digest,
  list,
  ...outcomes
}: DigestActionOptions): DigestActionControl {
  const { failure, isRequesting, send, dismiss } = useDigestRequest(token, meeting.id, outcomes);
  const files = list.state === 'ready' ? list.files : NO_FILES;
  const offered = offeredDigestAction(digest, files, { userId: user.id, hostId: meeting.hostId });
  const isAboutThisControl = offered !== null && failure?.version === digest?.version;

  return {
    offered,
    error: failure !== null && isAboutThisControl ? failure.message : null,
    isRequesting,
    request: () => {
      // Nothing is offered without a digest, so there is no press to send without one.
      if (digest !== null) {
        void send(digest.version);
      }
    },
    dismiss,
  };
}
