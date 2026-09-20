import type { MeetingFile } from '@repo/shared';

import { ApiError, openMeetingFileEvents } from './api-client';
import { readEventStream } from './sse';

/** The `event:` name the API sends a changed file under; anything else is a heartbeat. */
export const FILE_EVENT = 'file';

/**
 * How long to wait before reopening, by consecutive failure. The last entry repeats, though
 * in practice the fallback below is reached first when the failures are close together.
 */
export const RECONNECT_DELAYS_MS: ReadonlyArray<number> = [1_000, 2_000, 4_000];

/** Three drops this close together mean the stream does not work here, not that it blipped. */
export const MAX_STREAM_DROPS = 3;
export const DROP_WINDOW_MS = 60_000;

export interface WatchMeetingFilesOptions {
  token: string;
  meetingId: string;
  /** Aborts the request and the read. The watch resolves rather than throwing. */
  signal: AbortSignal;
  /** A file changed. The whole `MeetingFile`, to be applied by `applyFileEvent`. */
  onFile(file: MeetingFile): void;
  /**
   * The stream dropped and will be reopened. The caller refetches the list: anything that
   * happened while nothing was listening is only recoverable that way.
   */
  onDropped(): void;
  /** The token is no longer good — the caller's clear-and-redirect, as for any other call. */
  onUnauthorized(): void;
  /** The stream has dropped too often. The caller polls instead, for the page's lifetime. */
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
 * After `MAX_STREAM_DROPS` inside the window it stops trying and tells the caller, which is
 * what turns the three second poll back on for the rest of the page's life. Nothing turns
 * the stream back on: a page that has proved it cannot hold one is not improved by asking
 * every minute, and a reload is the user's own retry.
 *
 * Resolves rather than throwing, on every path. A caller's `catch` would only ever be able
 * to do what `onUnavailable` already does.
 */
export async function watchMeetingFiles({
  token,
  meetingId,
  signal,
  onFile,
  onDropped,
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

    // Before the wait, not after: the list is stale from the moment the stream stopped
    // carrying events, and the delay is for the connection, not for the data.
    onDropped();

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
