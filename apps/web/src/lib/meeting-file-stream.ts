import type { MeetingFile } from '@repo/shared';

import { ApiError, openMeetingFileEvents } from './api-client';
import { readEventStream } from './sse';

/** The `event:` name the API sends a changed file under; anything else is a heartbeat. */
export const FILE_EVENT = 'file';

/**
 * How long to wait before reopening, by consecutive failure. The last entry repeats, though
 * in practice the give-up rule below is reached first when the failures are close together.
 */
export const RECONNECT_DELAYS_MS: ReadonlyArray<number> = [1_000, 2_000, 4_000];

/** Three drops this close together mean the stream does not work here right now. */
export const MAX_STREAM_DROPS = 3;
export const DROP_WINDOW_MS = 60_000;

export interface WatchMeetingFilesOptions {
  token: string;
  meetingId: string;
  /** Aborts the request and the read. The watch resolves rather than throwing. */
  signal: AbortSignal;
  /**
   * A stream opened — the first one and every reconnect. From this moment the API is
   * watching the meeting for this connection, so every later change arrives as an event; the
   * caller refetches the list, which is the only thing that covers what happened before.
   */
  onOpen(): void;
  /** A file changed. The whole `MeetingFile`, to be applied by `applyFileEvent`. */
  onFile(file: MeetingFile): void;
  /** The token is no longer good — the caller's clear-and-redirect, as for any other call. */
  onUnauthorized(): void;
  /**
   * The stream has dropped too often and the watch is over. The caller polls instead, and
   * decides for itself when a stream is worth trying again.
   */
  onUnavailable(): void;
  /** Injectable for tests only; production waits on a real timer. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Keeps one meeting's event stream open, reopening it when it drops, until `signal` aborts.
 *
 * **Every ending is a drop, including a clean one.** The API closes a stream after its TTL,
 * so "the server ended it" is the ordinary case and reopening is the whole point. That is
 * also why the give-up rule counts drops inside a minute rather than drops in total: a TTL
 * of five minutes cannot produce three of them in sixty seconds, and a stream that is
 * genuinely broken produces them at once.
 *
 * **The list is the caller's to refetch, and `onOpen` is when.** Anything committed between
 * one stream ending and the next being subscribed on the server reaches nobody, and the only
 * repair is a list requested *after* the server is subscribed again. Refetching at the drop,
 * before the reconnect, would leave whatever happened during the wait unseen.
 *
 * After `MAX_STREAM_DROPS` inside the window it stops and tells the caller, whose poll takes
 * over. Stopping is not final, and must not be: an API restart looks exactly like a broken
 * stream from here — one close, then two refused connections — so the caller tries again
 * after a while (`useMeetingFiles` does, a minute later) rather than treating three drops as
 * proof that this page can never hold a stream.
 *
 * Resolves rather than throwing, on every path. A caller's `catch` would only ever be able
 * to do what `onUnavailable` already does.
 */
export async function watchMeetingFiles({
  token,
  meetingId,
  signal,
  onOpen,
  onFile,
  onUnauthorized,
  onUnavailable,
  wait = sleep,
}: WatchMeetingFilesOptions): Promise<void> {
  /** Drop instants inside the window, oldest first. */
  let drops: number[] = [];
  /** Consecutive failures to open or read, reset by a stream that opened. Indexes the delay. */
  let failures = 0;

  await connect();

  async function connect(): Promise<void> {
    if (signal.aborted) {
      return;
    }

    const outcome = await once();

    if (outcome === 'stop' || signal.aborted) {
      return;
    }

    const now = Date.now();
    drops = [...drops, now].filter((at) => now - at < DROP_WINDOW_MS);

    if (drops.length >= MAX_STREAM_DROPS) {
      onUnavailable();

      return;
    }

    const delayMs =
      outcome === 'ended'
        ? RECONNECT_DELAYS_MS[0]
        : RECONNECT_DELAYS_MS[Math.min(failures - 1, RECONNECT_DELAYS_MS.length - 1)];

    await wait(delayMs ?? 0, signal);

    // Recursion, not a loop with an `await` in it — the shape this workspace's lint rule
    // steers towards, and the same one `MeetingFileWorker.drainFrom` takes.
    return connect();
  }

  /** One connection, from open to close. `stop` means do not try again. */
  async function once(): Promise<'ended' | 'failed' | 'stop'> {
    try {
      const response = await openMeetingFileEvents(token, meetingId, { signal });
      failures = 0;

      if (signal.aborted) {
        return 'stop';
      }

      // A 200 with the stream's content type means Nest has committed the headers, which it
      // does on the first write — after the route subscribed this connection to the meeting.
      // From here on every change is an event, so this is the moment a list is worth fetching.
      onOpen();

      await readEventStream(response, receive, signal);

      return 'ended';
    } catch (error) {
      if (signal.aborted) {
        return 'stop';
      }

      // The same answer an expired token gets anywhere else. Reopening would only produce
      // another 401, and the caller is about to leave the page.
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized();

        return 'stop';
      }

      failures += 1;

      return 'failed';
    }
  }

  function receive(event: { type: string; data: string }): void {
    if (event.type !== FILE_EVENT) {
      return;
    }

    const file = parseFile(event.data);

    if (file !== null) {
      onFile(file);
    }
  }
}

/**
 * A `data:` payload that is not a `MeetingFile` is dropped rather than thrown: one
 * unreadable event must not end a stream that is otherwise working, and the next refetch
 * sees whatever it described anyway.
 */
function parseFile(data: string): MeetingFile | null {
  try {
    const parsed: unknown = JSON.parse(data);

    return typeof parsed === 'object' && parsed !== null && 'id' in parsed
      ? (parsed as MeetingFile)
      : null;
  } catch {
    return null;
  }
}

/** Resolves after `ms`, or at once when the watch is aborted while waiting. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);

    function stop(): void {
      clearTimeout(timer);
      resolve();
    }

    signal.addEventListener('abort', stop, { once: true });
  });
}
