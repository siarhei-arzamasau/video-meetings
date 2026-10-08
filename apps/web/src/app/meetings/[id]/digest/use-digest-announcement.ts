'use client';

import type { MeetingDigest } from '@repo/shared';
import { useEffect, useRef, useState } from 'react';

import { digestAnnouncement } from '@/lib/meeting-digest-announcements';
import type { Announcement } from '../files/use-files-announcement';

const SILENT: Announcement = { phrase: '', sequence: 0 };

/**
 * What the digest section's live region says: a phrase when the digest changes in a way only
 * a sighted reader would otherwise notice, and nothing until it does. The wording and the
 * choice of what is worth saying are `digestAnnouncement`'s.
 *
 * Derived from the digest the page holds rather than from stream events, so the fallback
 * poll announces what the stream would.
 *
 * **The first digest the page is given is never announced.** `previous` stays `null` until
 * one has arrived — the hook's own first render has none — so what the API says first is
 * the page's opening state, not a change.
 *
 * **A phrase worded like the last one is still a new announcement**, which is what `sequence`
 * is for, exactly as in `useFilesAnnouncement`: a retry that fails again says the same
 * sentence twice running, and as a bare string the second would change nothing in the page.
 */
export function useDigestAnnouncement(digest: MeetingDigest | null): Announcement {
  const [announcement, setAnnouncement] = useState(SILENT);
  const previousDigest = useRef<MeetingDigest | null>(null);

  useEffect(() => {
    const phrase = digestAnnouncement(previousDigest.current, digest);
    previousDigest.current = digest;

    if (phrase !== null) {
      setAnnouncement(({ sequence }) => ({ phrase, sequence: sequence + 1 }));
    }
  }, [digest]);

  return announcement;
}
