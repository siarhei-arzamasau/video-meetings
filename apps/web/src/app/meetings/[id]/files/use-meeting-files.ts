'use client';

import type { MeetingFile } from '@repo/shared';
import { useCallback } from 'react';

import { useFallbackPoll } from './use-fallback-poll';
import type { FilesList, FilesSnapshot } from './use-files-snapshot';
import { useFilesSnapshot } from './use-files-snapshot';
import { useFilesStream } from './use-files-stream';

export { POLL_INTERVAL_MS } from './use-fallback-poll';
export type { FilesList } from './use-files-snapshot';
export { STREAM_RETRY_MS } from './use-files-stream';

export interface MeetingFiles {
  list: FilesList;
  /** Refetch now. Used by "Try again", by the poll, and by a row whose retry was answered. */
  refresh(): void;
  /** Puts a just-uploaded file into the list without waiting for a refetch — if it is not there. */
  add(file: MeetingFile): void;
  /** Takes a just-deleted file out of the list without waiting for a refetch. */
  remove(fileId: string): void;
}

/**
 * The two changes the page makes to the list on its own account, without waiting for a
 * refetch: its own upload arriving, and its own delete going.
 *
 * **`add` never replaces a row.** What it is handed is the upload's answer — the file as it
 * was created, the earliest state it will ever have — on a connection of its own, so the
 * stream may already have said `uploaded`, `processing` and `ready` by the time it lands. A
 * row the list already has for that file is therefore as new or newer and is left alone; the
 * answer only fills the gap when the stream has not delivered the file yet, or there is no
 * stream. Written over the row it would put a finished file back to Processing, and for a
 * file nothing more happens to, no event would follow to correct it.
 */
function useLocalEdits({
  list,
  setList,
  refresh,
}: FilesSnapshot): Pick<MeetingFiles, 'add' | 'remove'> {
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
        current.state === 'ready' && !current.files.some(({ id }) => id === file.id)
          ? { state: 'ready', files: [file, ...current.files] }
          : current,
      );
    },
    [isReady, refresh, setList],
  );

  const remove = useCallback(
    (fileId: string): void => {
      setList((current) =>
        current.state === 'ready'
          ? { state: 'ready', files: current.files.filter(({ id }) => id !== fileId) }
          : current,
      );
    },
    [setList],
  );

  return { add, remove };
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
 * and after three drops inside a minute gives up; the three second poll then runs while a
 * file is processing or a recording is waiting on its transcript, and `STREAM_RETRY_MS` later
 * the stream is tried again. An API restart produces exactly those three drops, and a page must
 * not stay on the poll for good because of one. A retry that opens refetches the list too.
 *
 * **A retry's answer is not written into the list, which is why there is no `replace` here.**
 * It says what the row was when the retry left it, and it arrives on a connection of its own:
 * the stream may already have delivered that state and two later ones. Put over the row it
 * would take a file that has failed again back to "queued", and no event would follow to
 * correct it. A row whose retry was answered calls `refresh` instead — a list requested after
 * the retry is one this hook already knows how to put in order against the stream.
 *
 * A 401 from either is handed to `onUnauthorized` rather than shown: the gate owns that answer.
 */
export function useMeetingFiles(
  token: string,
  meetingId: string,
  onUnauthorized: () => void,
): MeetingFiles {
  const snapshot = useFilesSnapshot(token, meetingId, onUnauthorized);
  const { list, refresh, applyChange } = snapshot;
  const streamAvailable = useFilesStream({
    token,
    meetingId,
    refresh,
    onFile: applyChange,
    onUnauthorized,
  });

  useFallbackPoll(streamAvailable, list, snapshot.settled, refresh);

  const { add, remove } = useLocalEdits(snapshot);

  return { list, refresh, add, remove };
}
