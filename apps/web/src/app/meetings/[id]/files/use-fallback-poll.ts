'use client';

import { useEffect } from 'react';

import { isAwaitingWorker } from '@/lib/meeting-files';
import type { FilesList } from './use-files-snapshot';

/**
 * How often the list refetches while a worker still owes a result — **the fallback, not
 * the default, and not to be removed.** The event stream is what normally settles a row and
 * moves its transcription on, but a stream is the first thing a corporate proxy, a captive
 * portal, or a misconfigured reverse proxy breaks, and the PRD's "no websocket in v1" spirit
 * asks for a page that still works when it cannot hold one open. See `useMeetingFiles`.
 */
export const POLL_INTERVAL_MS = 3_000;

/**
 * The fallback, and only that: while a stream is open the list is already current, and a
 * poll beside it would be three requests a second across an open meeting page for nothing.
 * `isAwaitingWorker` still gates it, so the fallback stops once both workers are done.
 *
 * **`list` is a dependency on purpose.** Each list that lands is what arms the next timer; on
 * a condition alone the poll would fire once and stop.
 */
export function useFallbackPoll(
  streamAvailable: boolean,
  list: FilesList,
  refresh: () => void,
): void {
  useEffect(() => {
    if (streamAvailable || list.state !== 'ready' || !isAwaitingWorker(list.files)) {
      return;
    }

    const timer = setTimeout(refresh, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [streamAvailable, list, refresh]);
}
