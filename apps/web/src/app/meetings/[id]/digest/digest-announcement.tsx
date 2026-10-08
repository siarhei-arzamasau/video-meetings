'use client';

import type { MeetingDigest } from '@repo/shared';

import { useDigestAnnouncement } from './use-digest-announcement';

/**
 * One polite region for the digest, as the files have one. `aria-atomic`, so a phrase is
 * read whole rather than as whatever word changed.
 *
 * **It is not inside the section, and must not be moved there.** The section is drawn only
 * while there is a digest to show, and one of the things said here is that the digest was
 * removed: a region that went with the section could not say so. A live region also has to
 * be in the page before its text changes to be spoken at all.
 */
export function DigestAnnouncement({ digest }: { digest: MeetingDigest | null }) {
  const { phrase, sequence } = useDigestAnnouncement(digest);

  return (
    <output className="sr-only" aria-atomic="true">
      {/* Keyed on the phrase's number, so each phrase is a new node in the region: the same
          words written into the same node are no change, and a screen reader stays silent. */}
      <span key={sequence}>{phrase}</span>
    </output>
  );
}
