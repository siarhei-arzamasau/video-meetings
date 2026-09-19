'use client';

import type { MeetingFile } from '@repo/shared';
import { useCallback, useEffect, useState } from 'react';

import { ApiError, listMeetingFiles } from '@/lib/api-client';
import { isProcessing } from '@/lib/meeting-files';
import { describeFailure } from '@/lib/use-signed-in';

/** How often the list refetches while the worker still owes a result. */
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
  /** Takes a just-deleted file out of the list without waiting for a refetch. */
  remove(fileId: string): void;
}

/**
 * The file list for one meeting, with the PRD's freshness rule: while any file is `uploaded`
 * or `processing`, refetch every three seconds; stop when none is. The poll is re-evaluated
 * after every refresh — each response decides whether there will be another — and cleared
 * on unmount, so a page left open does not keep a dead meeting's list warm.
 *
 * A 401 mid-poll is handed to `onUnauthorized` rather than shown: the gate owns that answer.
 */
export function useMeetingFiles(
  token: string,
  meetingId: string,
  onUnauthorized: () => void,
): MeetingFiles {
  const [list, setList] = useState<FilesList>({ state: 'loading' });
  const [tick, setTick] = useState(0);

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

  useEffect(() => {
    if (list.state !== 'ready' || !isProcessing(list.files)) {
      return;
    }

    const timer = setTimeout(refresh, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [list, refresh]);

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

  const remove = useCallback((fileId: string): void => {
    setList((current) =>
      current.state === 'ready'
        ? { state: 'ready', files: current.files.filter(({ id }) => id !== fileId) }
        : current,
    );
  }, []);

  return { list, refresh, add, remove };
}
