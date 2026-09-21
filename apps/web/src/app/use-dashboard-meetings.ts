'use client';

import type { Meeting } from '@repo/shared';
import { useCallback, useEffect, useState } from 'react';

import { ApiError, countMeetings, listMeetings } from '@/lib/api-client';
import { LATEST_MEETINGS_COUNT } from '@/lib/meetings';
import { describeFailure } from '@/lib/use-signed-in';

/** What the dashboard shows about meetings: the latest few, and how many there are in all. */
export type DashboardMeetings =
  | { state: 'loading' }
  | { state: 'ready'; latest: ReadonlyArray<Meeting>; total: number }
  | { state: 'failed'; message: string };

/**
 * The dashboard's own requests, once there is a token: the latest few meetings and the total,
 * asked for together. Not the whole list — the endpoint still gives it, and it grows with every
 * meeting the user ever had, when the page shows three of them and a number.
 *
 * A 401 from either goes to `onUnauthorized`, which answers it as the gate does. `retry` starts
 * both requests again.
 */
export function useDashboardMeetings(
  token: string | null,
  onUnauthorized: () => void,
): { meetings: DashboardMeetings; retry(): void } {
  const [meetings, setMeetings] = useState<DashboardMeetings>({ state: 'loading' });
  // Bumped by `retry`, so the effect owns the whole load rather than a second copy of it.
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (token === null) {
      return;
    }

    let active = true;

    async function load(bearer: string) {
      try {
        const [latest, total] = await Promise.all([
          listMeetings(bearer, { order: 'desc', limit: LATEST_MEETINGS_COUNT }),
          countMeetings(bearer),
        ]);

        if (active) {
          setMeetings({ state: 'ready', latest, total });
        }
      } catch (error) {
        if (!active) {
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();

          return;
        }

        setMeetings({ state: 'failed', message: describeFailure(error) });
      }
    }

    void load(token);

    return () => {
      active = false;
    };
  }, [token, onUnauthorized, reloadCount]);

  const retry = useCallback((): void => {
    setMeetings({ state: 'loading' });
    setReloadCount((count) => count + 1);
  }, []);

  return { meetings, retry };
}
