'use client';

import type { MeetingFile } from '@repo/shared';
import { useEffect, useRef, useState } from 'react';

import { transcriptionAnnouncement } from '@/lib/meeting-file-announcements';
import { isProcessing, processingAnnouncement } from '@/lib/meeting-files';

export interface Announcement {
  phrase: string;
  /** How many phrases have been said, this one included; `0` until the first. */
  sequence: number;
}

const SILENT: Announcement = { phrase: '', sequence: 0 };

/**
 * What the files section's one live region says: a phrase when the list changes in a way
 * only a sighted reader would otherwise notice, and nothing until it does. Two things do —
 * the number of files still being processed, and a transcription that ends.
 *
 * Announced only on a change, never on the first render: a live region that reads the
 * page's opening state aloud is noise. Derived from the list rather than from stream
 * events, so the poll fallback announces the same thing.
 *
 * **`null` is "no list yet", and it is not an empty list.** The page renders before its files
 * have loaded, and a hook that took the placeholder for the opening list compared nothing
 * with the first real answer — and read "1 file is processing." to a reader who had only
 * just opened the page. The first list that arrives is the opening state; nothing is said
 * until it changes.
 *
 * **Changes that arrive in one render are one phrase.** The region holds one string, so a
 * second `setState` would replace the first before anything had read it.
 *
 * **A phrase worded like the last one is still a new announcement**, which is what `sequence`
 * is for. A retry that fails again says "Transcription of standup.mp3 failed." twice running,
 * and so do two recordings of one name. Held as a bare string, the second is a state React
 * already has: nothing renders, the region's text never changes, and a screen reader stays
 * silent — for the one reader who cannot see the chip come back. `FilesAnnouncement` keys the
 * region's node on the number, so every phrase is a change in the page.
 *
 * Pass the list itself, not a copy sorted for display: the comparison runs whenever the
 * array is a new one.
 */
export function useFilesAnnouncement(files: ReadonlyArray<MeetingFile> | null): Announcement {
  const [announcement, setAnnouncement] = useState(SILENT);
  const previousFiles = useRef<ReadonlyArray<MeetingFile> | null>(null);

  useEffect(() => {
    if (files === null) {
      return;
    }

    const previous = previousFiles.current;
    previousFiles.current = files;

    if (previous === null) {
      return;
    }

    const phrases = [
      processingChange(previous, files),
      transcriptionAnnouncement(previous, files),
    ].filter((phrase) => phrase !== null);

    if (phrases.length > 0) {
      const phrase = phrases.join(' ');

      setAnnouncement(({ sequence }) => ({ phrase, sequence: sequence + 1 }));
    }
  }, [files]);

  return announcement;
}

const countProcessing = (files: ReadonlyArray<MeetingFile>): number =>
  files.filter((file) => isProcessing([file])).length;

/** The processing phrase, when the number of files still being processed has changed. */
function processingChange(
  previous: ReadonlyArray<MeetingFile>,
  current: ReadonlyArray<MeetingFile>,
): string | null {
  const count = countProcessing(current);

  return countProcessing(previous) === count ? null : processingAnnouncement(count);
}
