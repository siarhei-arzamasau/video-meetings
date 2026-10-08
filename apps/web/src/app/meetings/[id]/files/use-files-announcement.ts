'use client';

import type { MeetingFile } from '@repo/shared';
import { useEffect, useRef, useState } from 'react';

import { transcriptionAnnouncement } from '@/lib/meeting-file-announcements';
import { isProcessing, processingAnnouncement } from '@/lib/meeting-files';

/**
 * What the files section's one live region says: a phrase when the list changes in a way
 * only a sighted reader would otherwise notice, and nothing until it does. Two things do —
 * the number of files still being processed, and a transcription that ends.
 *
 * Announced only on a change, never on the first render: a live region that reads the
 * page's opening state aloud is noise. Derived from the list rather than from stream
 * events, so the poll fallback announces the same thing.
 *
 * **Changes that arrive in one render are one phrase.** The region holds one string, so a
 * second `setState` would replace the first before anything had read it.
 *
 * Pass the list itself, not a copy sorted for display: the comparison runs whenever the
 * array is a new one.
 */
export function useFilesAnnouncement(files: ReadonlyArray<MeetingFile>): string {
  const [announcement, setAnnouncement] = useState('');
  const previousFiles = useRef<ReadonlyArray<MeetingFile> | null>(null);

  useEffect(() => {
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
      setAnnouncement(phrases.join(' '));
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
