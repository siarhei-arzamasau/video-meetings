'use client';

import type { MeetingFile } from '@repo/shared';
import { useCallback, useEffect, useState } from 'react';

import { ApiError, listMeetingFiles } from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';
import { applyFileEvent, isProcessing } from '@/lib/meeting-files';
import { describeFailure } from '@/lib/use-signed-in';

/**
 * How often the list refetches while the worker still owes a result — **the fallback, not
 * the default, and not to be removed.** The event stream is what normally moves a row from
 * Processing to Ready, but a stream is the first thing a corporate proxy, a captive portal,
 * or a misconfigured reverse proxy breaks, and the PRD's "no websocket in v1" spirit asks
 * for a page that still works when it cannot hold one open. See `useMeetingFiles`.
 */
export const POLL_INTERVAL_MS = 3_000;

export type FilesList =
  | { state: 'loading' }
  | { state: 'ready'; files: ReadonlyArray<MeetingFile> }
  | { state: 'failed'; message: string };

export interface MeetingFiles {
  list: FilesList;
  /** Refetch now. Used by "Try again" and by the poll. */
  refresh(): void;
  /** Puts a just-uploaded file into the list without waiting for a refetch. */
  add(file: MeetingFile): void;
  /** Puts the file as the API just answered with in place of the one the list has, where it is. */
  replace(file: MeetingFile): void;
  /** Takes a just-deleted file out of the list without waiting for a refetch. */
  remove(fileId: string): void;
}

/**
 * The file list for one meeting: fetched once, then kept current by the API's event stream,
 * with the Phase 1 poll behind it.
 *
 * **The list is fetched first and the stream opened after it**, so the rows a stream event
 * refers to are already there. The window between the two is a few milliseconds in which
 * somebody else's change could land in neither; it closes at the next drop, because every
 * reconnect refetches the list.
 *
 * Events are applied by `applyFileEvent` — insert, replace where it is, remove on `deleted`
 * — never by re-fetching, which is what makes the Processing chip disappear the moment the
 * worker finishes rather than up to three seconds later.
 *
 * **The poll is the fallback.** `watchMeetingFiles` reopens a dropped stream with a backoff,
 * and after three drops inside a minute it gives up for good; only then does the three
 * second poll run, and it runs for the rest of the page's life. Nothing turns the stream
 * back on — a page that has proved it cannot hold one is not improved by asking again, and a
 * reload is the user's own retry.
 *
 * A 401 from either is handed to `onUnauthorized` rather than shown: the gate owns that answer.
 */
export function useMeetingFiles(
  token: string,
  meetingId: string,
  onUnauthorized: () => void,
): MeetingFiles {
  const [list, setList] = useState<FilesList>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  // Whether the first list has landed: the stream is opened after it, not beside it.
  const [listed, setListed] = useState(false);
  // Flipped once, by three drops inside a minute, and never back. The poll's condition.
  const [streamAvailable, setStreamAvailable] = useState(true);

  const refresh = useCallback((): void => {
    setTick((count) => count + 1);
  }, []);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const files = await listMeetingFiles(token, meetingId);

        if (active) {
          setList({ state: 'ready', files });
          setListed(true);
        }
      } catch (error) {
        if (!active) {
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();

          return;
        }

        setList((current) =>
          // A poll that fails does not blank a list that was fine a moment ago.
          current.state === 'ready'
            ? current
            : { state: 'failed', message: describeFailure(error) },
        );
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, [token, meetingId, tick, onUnauthorized]);

  // Applied through the updater, never through `list`: this effect must not restart every
  // time a file changes, and it would if the list were one of its dependencies.
  const applyChange = useCallback((file: MeetingFile): void => {
    setList((current) =>
      current.state === 'ready'
        ? { state: 'ready', files: applyFileEvent(current.files, file) }
        : current,
    );
  }, []);

  useEffect(() => {
    if (!listed || !streamAvailable) {
      return;
    }

    const controller = new AbortController();

    void watchMeetingFiles({
      token,
      meetingId,
      signal: controller.signal,
      onFile: applyChange,
      // A drop means events were missed while nothing was listening, and only a list can
      // say which. The watcher reopens after this returns.
      onDropped: refresh,
      onUnauthorized,
      onUnavailable: () => setStreamAvailable(false),
    });

    // Leaving the page hangs up: a stream nobody is reading is a connection the API holds
    // open until its TTL, and one per navigation adds up.
    return () => {
      controller.abort();
    };
  }, [token, meetingId, listed, streamAvailable, applyChange, refresh, onUnauthorized]);

  // The fallback, and only that: while a stream is open the list is already current, and a
  // poll beside it would be three requests a second across an open meeting page for nothing.
  // `isProcessing` still gates it, so the fallback stops when the worker is done.
  useEffect(() => {
    if (streamAvailable || list.state !== 'ready' || !isProcessing(list.files)) {
      return;
    }

    const timer = setTimeout(refresh, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [streamAvailable, list, refresh]);

  // While the list is loading or failed there is nothing to prepend to, and dropping the file
  // would make a successful upload vanish until the next refetch — so that case refetches now.
  const isReady = list.state === 'ready';
  const add = useCallback(
    (file: MeetingFile): void => {
      if (!isReady) {
        refresh();

        return;
      }

      setList((current) =>
        current.state === 'ready'
          ? { state: 'ready', files: [file, ...current.files.filter(({ id }) => id !== file.id)] }
          : current,
      );
    },
    [isReady, refresh],
  );

  // In place, not prepended: the list is newest first, and a retried file that jumped to the
  // top would jump back down at the next poll. A file the list does not have yet is the
  // `add` case, and refetching is the honest answer to a list that is not ready.
  const replace = useCallback(
    (file: MeetingFile): void => {
      if (!isReady) {
        refresh();

        return;
      }

      setList((current) =>
        current.state === 'ready'
          ? {
              state: 'ready',
              files: current.files.map((existing) => (existing.id === file.id ? file : existing)),
            }
          : current,
      );
    },
    [isReady, refresh],
  );

  const remove = useCallback((fileId: string): void => {
    setList((current) =>
      current.state === 'ready'
        ? { state: 'ready', files: current.files.filter(({ id }) => id !== fileId) }
        : current,
    );
  }, []);

  return { list, refresh, add, replace, remove };
}
