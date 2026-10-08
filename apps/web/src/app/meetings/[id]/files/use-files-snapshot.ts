'use client';

import type { MeetingFile } from '@repo/shared';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, listMeetingFiles } from '@/lib/api-client';
import { applyFileEvent } from '@/lib/meeting-files';
import { describeFailure } from '@/lib/use-signed-in';

export type FilesList =
  | { state: 'loading' }
  | { state: 'ready'; files: ReadonlyArray<MeetingFile> }
  | { state: 'failed'; message: string };

export interface FilesSnapshot {
  list: FilesList;
  setList: Dispatch<SetStateAction<FilesList>>;
  /** Refetch now. */
  refresh(): void;
  /** Applies one change from the event stream, where the insert / replace / remove rule puts it. */
  applyChange(file: MeetingFile): void;
}

interface Fetch {
  token: string;
  meetingId: string;
  /** False once the effect that sent this fetch is cleaned up: its answer is then nobody's. */
  isActive(): boolean;
  pending: RefObject<MeetingFile[] | null>;
  setList: Dispatch<SetStateAction<FilesList>>;
  onUnauthorized(): void;
}

/** One fetch of the list, and what its answer does to the state — see `useFilesSnapshot`. */
async function load({
  token,
  meetingId,
  isActive,
  pending,
  setList,
  onUnauthorized,
}: Fetch): Promise<void> {
  try {
    const files = await listMeetingFiles(token, meetingId);

    if (!isActive()) {
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
    if (!isActive()) {
      return;
    }

    pending.current = null;

    if (error instanceof ApiError && error.status === 401) {
      onUnauthorized();

      return;
    }

    setList((current) =>
      // A poll that fails does not blank a list that was fine a moment ago.
      current.state === 'ready' ? current : { state: 'failed', message: describeFailure(error) },
    );
  }
}

/**
 * The list as the API last answered with it, and the one place a fetch and an event are put
 * in order.
 *
 * An event says what a row is now; a list says what every row was when the server ran the
 * query; and nothing on this side can put the two in order. So events arriving while a fetch
 * is in flight are replayed on top of the snapshot when it lands (`pending`), because the
 * snapshot may have been read before they were committed.
 *
 * A 401 is handed to `onUnauthorized` rather than shown: the gate owns that answer.
 */
export function useFilesSnapshot(
  token: string,
  meetingId: string,
  onUnauthorized: () => void,
): FilesSnapshot {
  const [list, setList] = useState<FilesList>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  // Events that arrived while a fetch was in flight, to replay on top of the snapshot it
  // brings back; `null` while nothing is in flight. A ref, so `applyChange` stays stable.
  const pending = useRef<MeetingFile[] | null>(null);

  const refresh = useCallback((): void => {
    setTick((count) => count + 1);
  }, []);

  useEffect(() => {
    let active = true;
    pending.current = [];

    void load({ token, meetingId, isActive: () => active, pending, setList, onUnauthorized });

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

  return { list, setList, refresh, applyChange };
}
