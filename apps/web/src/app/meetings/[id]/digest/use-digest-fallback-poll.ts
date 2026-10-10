'use client';

import { useEffect, useRef } from 'react';

import { isDigestUnderWay, transcribedRecordingIds } from '@/lib/meeting-digest';
import { POLL_INTERVAL_MS } from '../files/use-fallback-poll';
import type { FilesList } from '../files/use-files-snapshot';
import type { MeetingDigestFeed } from './use-meeting-digest';

/** What identifies the recordings a digest would be built from; `null` while there is no list. */
function transcribedKeyOf(list: FilesList): string | null {
  return list.state === 'ready' ? transcribedRecordingIds(list.files).join(',') : null;
}

/** The longest a fetch that keeps failing waits before it is sent again. */
export const MAX_DIGEST_RETRY_MS = 60_000;

/**
 * How long after its `failedFetches`-th failure in a row a fetch is sent again: the files'
 * interval, doubled each time, up to a minute. An API that is restarting is caught up with in
 * seconds; one that stays down, or an endpoint that answers 500 to everything, is not asked
 * every three seconds by every open page for as long as it lasts.
 */
export function digestRetryDelayMs(failedFetches: number): number {
  return Math.min(POLL_INTERVAL_MS * 2 ** (failedFetches - 1), MAX_DIGEST_RETRY_MS);
}

/**
 * The digest's own reasons to be asked for again, at the files' interval. Beside an open
 * stream a change normally arrives as an event, and a poll would be a request every three
 * seconds for nothing — so the one that is a poll runs only without one.
 *
 * - **A fetch that failed, with a stream or without.** The digest has no error state and no
 *   "Try again": a fetch that fails changes nothing on the page, so nothing but this would
 *   ever ask again. A stream does not make up for it — an event says that a digest changed,
 *   and one that is simply there never does, so a page whose only fetch was lost would show
 *   no digest until the stream next reconnected, minutes later. It stops with the first
 *   fetch that lands, **waits longer after each one that does not** (`digestRetryDelayMs`),
 *   and never starts for a fetch the API refused — `failedFetches` does not count a 403 or a
 *   404, which the next try would get again.
 * - **A digest that is queued or being generated**, without a stream, until it is neither.
 *   `settled` is a dependency for the reason it is one of the files' poll: each fetch that
 *   comes back arms the next, and a failed one leaves `digest` the very object it was.
 * - **The list's transcribed recordings changing, with a stream or without.** A digest with
 *   no status gives the poll above nothing to run on, and what starts one is a recording being
 *   transcribed; what withdraws one is such a recording being deleted. Both reach the page
 *   through its list — by the stream's file events, the files' own poll, or the page's own
 *   delete — so that is when the digest is asked for. A recording that is merely there when
 *   the page loads is not a change.
 *
 *   **Beside a stream it is not redundant, though the digest's own event usually says the
 *   same.** That event is sent by the API's reaction to the change, and a reaction that fails
 *   is logged and sends nothing — while the file's event has already told this page the
 *   recording is gone. Without the fetch, the words of a deleted recording stayed on the page
 *   until the stream next reconnected, minutes later; the API withholds them from the moment
 *   the delete commits, so asking is all it takes. Two requests per change, not a poll.
 *
 *   **It is asked for twice: at once, and an interval later.** The API answers a delete, and
 *   reports a recording transcribed, before it has decided what that does to the digest — so
 *   the first answer can be the digest as it was, with nothing queued yet and so nothing for
 *   the poll above to run on. The second is sent after the API has had three seconds for a
 *   few statements. One more, not a poll: a meeting whose digest is switched off answers the
 *   same thing for ever.
 */
export function useDigestFallbackPoll(
  streamAvailable: boolean,
  { digest, settled, failedFetches, refresh }: MeetingDigestFeed,
  list: FilesList,
): void {
  useEffect(() => {
    const isRetrying = failedFetches > 0;

    if (!isRetrying && (streamAvailable || !isDigestUnderWay(digest))) {
      return;
    }

    const delayMs = isRetrying ? digestRetryDelayMs(failedFetches) : POLL_INTERVAL_MS;
    const timer = setTimeout(refresh, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [streamAvailable, digest, settled, failedFetches, refresh]);

  const transcribed = transcribedKeyOf(list);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    const previous = seen.current;
    seen.current = transcribed;

    if (previous === null || transcribed === null || previous === transcribed) {
      return;
    }

    refresh();
    const followUp = setTimeout(refresh, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(followUp);
    };
  }, [transcribed, refresh]);
}
