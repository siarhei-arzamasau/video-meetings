'use client';

import type { MeetingDigest, MeetingFile } from '@repo/shared';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useState } from 'react';

import { watchMeetingFiles } from '@/lib/meeting-file-stream';

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

interface FilesStream {
  token: string;
  meetingId: string;
  /**
   * Refetches what the stream keeps current — the list, and the digest when the page follows
   * one: an open stream, or one given up on, each needs a fetch of its own.
   */
  refresh(): void;
  onFile(file: MeetingFile): void;
  /** The meeting's digest, which rides this stream. Absent where only the files are followed. */
  onDigest?: ((digest: MeetingDigest) => void) | undefined;
  onUnauthorized(): void;
}

/** The retry, and the reason giving up is not for good: see `STREAM_RETRY_MS`. */
function useStreamRetry(
  streamAvailable: boolean,
  setStreamAvailable: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (streamAvailable) {
      return;
    }

    const timer = setTimeout(() => setStreamAvailable(true), STREAM_RETRY_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [streamAvailable, setStreamAvailable]);
}

/**
 * Holds the meeting's event stream open, and answers whether there is one to rely on — which
 * is the fallback poll's condition, for the files and for the digest alike.
 *
 * `watchMeetingFiles` reopens a dropped stream with a backoff and after three drops inside a
 * minute gives up; `STREAM_RETRY_MS` later the stream is tried again. An API restart produces
 * exactly those three drops, and a page must not stay on the poll for good because of one.
 */
export function useFilesStream({
  token,
  meetingId,
  refresh,
  onFile,
  onDigest,
  onUnauthorized,
}: FilesStream): boolean {
  // Flipped off by three drops inside a minute, and back on by the retry. The poll's condition.
  const [streamAvailable, setStreamAvailable] = useState(true);

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
      onFile,
      ...(onDigest === undefined ? {} : { onDigest }),
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
  }, [token, meetingId, streamAvailable, onFile, onDigest, refresh, onUnauthorized]);

  useStreamRetry(streamAvailable, setStreamAvailable);

  return streamAvailable;
}
