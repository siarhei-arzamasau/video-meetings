'use client';

import type { MeetingDigest } from '@repo/shared';

import { useDigestFallbackPoll } from './digest/use-digest-fallback-poll';
import { useMeetingDigest } from './digest/use-meeting-digest';
import type { MeetingFiles } from './files/use-meeting-files';
import { useMeetingFiles } from './files/use-meeting-files';

export interface MeetingUpdates {
  files: MeetingFiles;
  /** The meeting's digest; `null` until the API has answered once. */
  digest: MeetingDigest | null;
  /** Fetch the digest now: what a refused Generate or Retry is answered with. */
  refreshDigest(): void;
  /** Take the digest the API answered a Generate or a Retry with (`MeetingDigestFeed.accept`). */
  acceptDigest(digest: MeetingDigest): void;
}

/**
 * Everything on a meeting page that changes without the reader doing anything: its files and
 * its digest, kept current over **one stream with two consumers**.
 *
 * The API sends both on `GET /meetings/:id/files/events`, a file under `file` and the digest
 * under `digest`. `useMeetingFiles` holds that connection; `useMeetingDigest` holds none, and
 * is handed to it as the second consumer — refetched at every open as the list is, and given
 * each `digest` event. A stream per section would double the long-lived connections of every
 * open page, against the six a browser allows one origin.
 *
 * The order of the three calls is the order of their dependencies: the digest's `refresh`
 * and `receive` go into the stream, and whether there is a stream comes back out for the
 * digest's fallback poll.
 */
export function useMeetingUpdates(
  token: string,
  meetingId: string,
  onUnauthorized: () => void,
): MeetingUpdates {
  const feed = useMeetingDigest(token, meetingId, onUnauthorized);
  const files = useMeetingFiles(token, meetingId, onUnauthorized, feed);

  useDigestFallbackPoll(files.streamAvailable, feed, files.list);

  return { files, digest: feed.digest, refreshDigest: feed.refresh, acceptDigest: feed.accept };
}
