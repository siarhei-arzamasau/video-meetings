'use client';

import type { MeetingFile } from '@repo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

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

/**
 * How long the poll has the page to itself after the stream has been given up on, before
 * the stream is tried once more.
 *
 * At the moment it happens, an API restart is indistinguishable from a stream this network
 * cannot hold: one close, then two refused connections, which is exactly the give-up rule. A
 * page that never asked again would stay on the poll until reloaded — and the poll only runs
 * while something is processing, so for a quiet page that means never learning about anyone
 * else's upload again. A minute is long enough that a genuinely blocked stream costs three
 * failed requests a minute, and short enough that a deploy is a one-minute blip.
 */
export const STREAM_RETRY_MS = 60_000;

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
 * The file list for one meeting: fetched, then kept current by the API's event stream, with
 * the Phase 1 poll behind it.
 *
 * **The stream is opened at mount beside the first fetch, and the list is fetched again
 * every time a stream opens.** An event says what a row is now; a list says what every row
 * was when the server ran the query; and nothing on this side can put the two in order. So
 * the rule is that only a list requested *after* the server subscribed this connection —
 * which `onOpen` is the signal for — can be trusted to hold everything no event will repeat,
 * and that events arriving while a fetch is in flight are replayed on top of the snapshot
 * when it lands (`pending`), because the snapshot may have been read before they were
 * committed. The first fetch is sent at mount all the same, so a page on a network that
 * cannot hold a stream shows its files no later than it did before there was one.
 *
 * Events are applied by `applyFileEvent` — insert, replace where it is, remove on `deleted`
 * — never by re-fetching, which is what makes the Processing chip disappear the moment the
 * worker finishes rather than up to three seconds later.
 *
 * **The poll is the fallback.** `watchMeetingFiles` reopens a dropped stream with a backoff
 * and after three drops inside a minute gives up; the three second poll then runs while
 * anything is processing, and `STREAM_RETRY_MS` later the stream is tried again. An API
 * restart produces exactly those three drops, and a page must not stay on the poll until
 * it is reloaded because of one. A retry that opens refetches the list like any other open.
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
  // Flipped off by three drops inside a minute, and back on by the retry. The poll's condition.
  const [streamAvailable, setStreamAvailable] = useState(true);
  // Events that arrived while a fetch was in flight, to replay on top of the snapshot it
  // brings back; `null` while nothing is in flight. A ref, so `applyChange` stays stable.
  const pending = useRef<MeetingFile[] | null>(null);

  const refresh = useCallback((): void => {
    setTick((count) => count + 1);
  }, []);

  useEffect(() => {
    let active = true;
    pending.current = [];

    async function load() {
      try {
        const files = await listMeetingFiles(token, meetingId);

        if (!active) {
          return;
        }

        // The server read these rows some time before it answered, so an event that arrived
        // meanwhile may describe a later state than the snapshot does — or an earlier one,
        // in which case the newer event behind it is in the same buffer or already on the
        // stream. Replaying them in order lands on the right answer either way.
        const missed = pending.current ?? [];
        pending.current = null;
        setList({
          state: 'ready',
          files: missed.reduce<ReadonlyArray<MeetingFile>>(applyFileEvent, files),
        });
      } catch (error) {
        if (!active) {
          return;
        }

        pending.current = null;

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
      pending.current = null;
    };
  }, [token, meetingId, tick, onUnauthorized]);

  // Applied through the updater, never through `list`: the stream effect must not restart
  // every time a file changes, and it would if the list were one of its dependencies.
  const applyChange = useCallback((file: MeetingFile): void => {
    // Kept for the fetch in flight, if there is one, as well as applied now.
    pending.current?.push(file);
    setList((current) =>
      current.state === 'ready'
        ? { state: 'ready', files: applyFileEvent(current.files, file) }
        : current,
    );
  }, []);

  useEffect(() => {
    if (!streamAvailable) {
      return;
    }

    const controller = new AbortController();

    void watchMeetingFiles({
      token,
      meetingId,
      signal: controller.signal,
      // Every open, not only the reconnects: the list the mount fetched may have been read
      // before the server subscribed this connection, and only one requested after can be
      // trusted to hold whatever no event will repeat.
      onOpen: refresh,
      onFile: applyChange,
      onUnauthorized,
      // The last stream missed things between its drop and now, and the poll only runs while
      // something is processing — so one fetch now, then the poll, then a retry in a minute.
      onUnavailable: () => {
        setStreamAvailable(false);
        refresh();
      },
    });

    // Leaving the page hangs up: a stream nobody is reading is a connection the API holds
    // open until its TTL, and one per navigation adds up.
    return () => {
      controller.abort();
    };
  }, [token, meetingId, streamAvailable, applyChange, refresh, onUnauthorized]);

  // The retry, and the reason giving up is not for good: see `STREAM_RETRY_MS`.
  useEffect(() => {
    if (streamAvailable) {
      return;
    }

    const timer = setTimeout(() => setStreamAvailable(true), STREAM_RETRY_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [streamAvailable]);

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
