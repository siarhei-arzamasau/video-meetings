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

/**
 * The digest's own reasons to be asked for again, at the files' interval. Beside an open
 * stream every change arrives as an event, and a poll would be a request every three seconds
 * for nothing — so two of the three run only without one.
 *
 * - **A fetch that failed, with a stream or without.** The digest has no error state and no
 *   "Try again": a fetch that fails changes nothing on the page, so nothing but this would
 *   ever ask again. A stream does not make up for it — an event says that a digest changed,
 *   and one that is simply there never does, so a page whose only fetch was lost would show
 *   no digest until the stream next reconnected, minutes later. It stops with the first
 *   fetch that lands.
 * - **A digest that is queued or being generated**, without a stream, until it is neither.
 *   `settled` is a dependency for the reason it is one of the files' poll: each fetch that
 *   comes back arms the next, and a failed one leaves `digest` the very object it was.
 * - **The list's transcribed recordings changing**, without a stream. A digest with no status
 *   gives the poll above nothing to run on, and what starts one is a recording being
 *   transcribed; what withdraws one is such a recording being deleted. Both reach the page
 *   through its list — by the files' own poll, or by the page's own delete — so that is when
 *   the digest is asked for. A recording that is merely there when the page loads is not a
 *   change.
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
  { digest, settled, lastFetchFailed, refresh }: MeetingDigestFeed,
  list: FilesList,
): void {
  useEffect(() => {
    const isOwedAnotherFetch = lastFetchFailed || (!streamAvailable && isDigestUnderWay(digest));

    if (!isOwedAnotherFetch) {
      return;
    }

    const timer = setTimeout(refresh, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [streamAvailable, digest, settled, lastFetchFailed, refresh]);

  const transcribed = transcribedKeyOf(list);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    const previous = seen.current;
    seen.current = transcribed;

    if (streamAvailable || previous === null || transcribed === null || previous === transcribed) {
      return;
    }

    refresh();
    const followUp = setTimeout(refresh, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(followUp);
    };
  }, [streamAvailable, transcribed, refresh]);
}
