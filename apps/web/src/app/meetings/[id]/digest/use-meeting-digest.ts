'use client';

import type { MeetingDigest } from '@repo/shared';
import { useCallback, useEffect, useState } from 'react';

import { ApiError, fetchMeetingDigest } from '@/lib/api-client';
import { laterDigest } from '@/lib/meeting-digest';

export interface MeetingDigestFeed {
  /** The newest digest the page has been given; `null` until the API has answered once. */
  digest: MeetingDigest | null;
  /**
   * How many fetches have come back, landed or failed. A fetch that fails leaves `digest`
   * the very object it was, so this is the only thing that says one has returned.
   */
  settled: number;
  /** The last fetch to come back failed: what is held may be older than what was asked for. */
  lastFetchFailed: boolean;
  /** Fetch now. Stable between renders: the stream's effect depends on it. */
  refresh(): void;
  /** One `digest` event from the stream. Stable between renders, for the same reason. */
  receive(digest: MeetingDigest): void;
  /**
   * The digest the API answered a Generate or a Retry with. **Taken as a fetch is**: it is
   * the API's answer to this page, so of two with one version it wins, and against a higher
   * one already held it loses — which is the case that matters. The answer travels on a
   * connection of its own, and the stream may by then have said `queued`, a worker's claim,
   * and the next failure; a file's retry has to refetch the list to be put in order against
   * that, and a digest only has to be compared.
   */
  accept(digest: MeetingDigest): void;
}

interface Fetch {
  token: string;
  meetingId: string;
  /** False once the effect that sent this fetch is cleaned up: its answer is then nobody's. */
  isActive(): boolean;
  /** Once per fetch that comes back to a live effect: the digest, or `null` when it failed. */
  onSettled(digest: MeetingDigest | null): void;
  onUnauthorized(): void;
}

/** One fetch of the digest. A 401 is the gate's answer, and settles nothing here. */
async function load({
  token,
  meetingId,
  isActive,
  onSettled,
  onUnauthorized,
}: Fetch): Promise<void> {
  try {
    const fetched = await fetchMeetingDigest(token, meetingId);

    if (isActive()) {
      onSettled(fetched);
    }
  } catch (error) {
    if (!isActive()) {
      return;
    }

    if (error instanceof ApiError && error.status === 401) {
      onUnauthorized();

      return;
    }

    onSettled(null);
  }
}

/**
 * The fetching half: one fetch at mount and one per `refresh`, each handed to `onFetched`
 * when it lands, and counted either way. `onFetched` must keep its identity between renders.
 */
function useDigestFetches(
  { token, meetingId, onUnauthorized }: Pick<Fetch, 'token' | 'meetingId' | 'onUnauthorized'>,
  onFetched: (digest: MeetingDigest) => void,
): Pick<MeetingDigestFeed, 'settled' | 'lastFetchFailed' | 'refresh'> {
  const [tick, setTick] = useState(0);
  const [fetches, setFetches] = useState({ settled: 0, lastFetchFailed: false });

  const refresh = useCallback((): void => setTick((count) => count + 1), []);

  useEffect(() => {
    let active = true;

    void load({
      token,
      meetingId,
      isActive: () => active,
      onSettled: (fetched) => {
        if (fetched !== null) {
          onFetched(fetched);
        }

        setFetches(({ settled }) => ({ settled: settled + 1, lastFetchFailed: fetched === null }));
      },
      onUnauthorized,
    });

    return () => {
      active = false;
    };
  }, [token, meetingId, tick, onUnauthorized, onFetched]);

  return { ...fetches, refresh };
}

/**
 * The meeting's digest: fetched at mount and whenever `refresh` is called, and kept current
 * by the events `receive` is handed.
 *
 * **Whichever arrives, the higher version is kept** (`laterDigest`), and that one rule is
 * everything that orders a fetch against an event here. The files list needs a buffer of
 * events to replay over each snapshot because a file carries no version; a digest does, so a
 * fetch that lands late is simply not newer than what an event already brought. That is also
 * why a fetch still in flight when another is asked for is let go rather than waited on.
 *
 * **It holds no stream of its own.** A digest rides the meeting's one stream, which
 * `useMeetingFiles` holds: this hook is given to it as that stream's second consumer, and is
 * refetched at every open exactly as the list is.
 *
 * **A fetch that fails changes nothing on the page.** There is no error state: a digest is
 * not something the reader asked for, and the files section beside it already says when the
 * API cannot be reached. What was held stays, and `lastFetchFailed` is what has
 * `useDigestFallbackPoll` ask again — beside an open stream too, since no event repeats a
 * digest that did not change. A 401 is handed to `onUnauthorized`: the gate owns that answer.
 */
export function useMeetingDigest(
  token: string,
  meetingId: string,
  onUnauthorized: () => void,
): MeetingDigestFeed {
  const [held, setHeld] = useState<MeetingDigest | null>(null);
  const onFetched = useCallback((fetched: MeetingDigest): void => {
    setHeld((current) => laterDigest(current, fetched, 'fetch'));
  }, []);
  const fetches = useDigestFetches({ token, meetingId, onUnauthorized }, onFetched);

  const receive = useCallback(
    (incoming: MeetingDigest): void => {
      // The stream is this meeting's, so anything else is not addressed to this page.
      if (incoming.meetingId === meetingId) {
        setHeld((current) => laterDigest(current, incoming, 'event'));
      }
    },
    [meetingId],
  );
  const accept = useCallback(
    (answered: MeetingDigest): void => {
      // An answer that outlived the meeting it was asked about is nobody's.
      if (answered.meetingId === meetingId) {
        setHeld((current) => laterDigest(current, answered, 'fetch'));
      }
    },
    [meetingId],
  );

  // A digest held from the meeting this component showed before is not this meeting's.
  const digest = held?.meetingId === meetingId ? held : null;

  return { digest, ...fetches, receive, accept };
}
