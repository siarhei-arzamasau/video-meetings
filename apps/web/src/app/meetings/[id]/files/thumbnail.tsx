'use client';

import type { MeetingFile } from '@repo/shared';
import { useEffect, useState } from 'react';

import { FileIcon } from '@/components/icons';
import { fetchThumbnail } from '@/lib/api-client';

/**
 * The thumbnail once there is one, else a type icon. Fetched with the bearer header into an
 * object URL because an `<img src>` cannot carry the token; revoked when the row unmounts or
 * the thumbnail changes so the blob does not outlive the row.
 */
export function Thumbnail({ token, file }: { token: string; file: MeetingFile }) {
  const { thumbnailPath, meetingId, id } = file;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (thumbnailPath === undefined) {
      setUrl(null);

      return;
    }

    let objectUrl: string | null = null;
    let active = true;

    void fetchThumbnail(token, meetingId, id)
      .then((blob) => {
        if (!active) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        // A missing thumbnail is a cosmetic loss: the icon stays.
        if (active) {
          setUrl(null);
        }
      });

    return () => {
      active = false;

      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [token, meetingId, id, thumbnailPath]);

  if (url === null) {
    return (
      <span className="bg-default text-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
        <FileIcon />
      </span>
    );
  }

  // Decorative: the name beside it is the accessible text.
  return <img src={url} alt="" className="size-10 shrink-0 rounded-lg object-cover" />;
}
