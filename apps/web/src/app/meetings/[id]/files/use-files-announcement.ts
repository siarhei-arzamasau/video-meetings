'use client';

import type { MeetingFile } from '@repo/shared';
import { useEffect, useRef, useState } from 'react';

import { isProcessing, processingAnnouncement } from '@/lib/meeting-files';

/**
 * What the files section's one live region says: a phrase when the list changes in a way
 * only a sighted reader would otherwise notice, and nothing until it does.
 *
 * Announced only on a change, never on the first render: a live region that reads the
 * page's opening state aloud is noise. Derived from the list rather than from stream
 * events, so the poll fallback announces the same thing.
 */
export function useFilesAnnouncement(files: ReadonlyArray<MeetingFile>): string {
  const [announcement, setAnnouncement] = useState('');
  const processingCount = files.filter((file) => isProcessing([file])).length;
  const previousProcessing = useRef<number | null>(null);

  useEffect(() => {
    const previous = previousProcessing.current;
    previousProcessing.current = processingCount;

    if (previous !== null && previous !== processingCount) {
      setAnnouncement(processingAnnouncement(processingCount));
    }
  }, [processingCount]);

  return announcement;
}
