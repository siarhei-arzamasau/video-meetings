'use client';

import type { MeetingFile } from '@repo/shared';

import { useFilesAnnouncement } from './use-files-announcement';

interface FilesAnnouncementProps {
  /** The list itself, not a copy sorted for display: see `useFilesAnnouncement`. */
  files: ReadonlyArray<MeetingFile>;
}

/**
 * One polite region for the whole files section. Since the page follows its files over a
 * stream, a row settles, arrives, or vanishes with no action from the reader, and the chip
 * going is a change only a sighted one sees. `aria-atomic`, so the phrase is read whole rather
 * than as whatever word changed.
 */
export function FilesAnnouncement({ files }: FilesAnnouncementProps) {
  const { phrase, sequence } = useFilesAnnouncement(files);

  return (
    <output className="sr-only" aria-atomic="true">
      {/* Keyed on the phrase's number, so each phrase is a new node in the region. A screen
          reader speaks a region when its contents change, and the same words written into
          the same node are no change at all. */}
      <span key={sequence}>{phrase}</span>
    </output>
  );
}
