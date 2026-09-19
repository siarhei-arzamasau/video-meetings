'use client';

import { Button, Chip, Spinner, Tooltip } from '@heroui/react';
import type { MeetingFile } from '@repo/shared';
import { useEffect, useState } from 'react';

import { DownloadIcon, FileIcon, TrashIcon, WarningIcon } from '@/components/icons';
import { ApiError, downloadMeetingFile, fetchThumbnail } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/date-time';
import { formatFileSize, statusPresentation } from '@/lib/meeting-files';

interface FileRowProps {
  token: string;
  file: MeetingFile;
  isMine: boolean;
  canDelete: boolean;
  onDelete(file: MeetingFile): void;
  onUnauthorized(): void;
}

export function FileRow({
  token,
  file,
  isMine,
  canDelete,
  onDelete,
  onUnauthorized,
}: FileRowProps) {
  const status = statusPresentation(file);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  async function download() {
    setIsDownloading(true);
    setDownloadError(null);

    try {
      const blob = await downloadMeetingFile(token, file.meetingId, file.id);
      // The token cannot ride on an `<a href>`, so the bytes are fetched with the bearer
      // header and handed to the browser as an object URL under the original name.
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      // Revoked on the next tick: revoking synchronously races the click in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized();

        return;
      }

      setDownloadError(
        error instanceof ApiError ? error.message : 'The download failed. Try again.',
      );
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <Thumbnail token={token} file={file} />

      {/* `basis-48`: the text column claims twelve rem before the chip and the actions are
          allowed to share its line, so on a phone they wrap under it instead of squeezing it. */}
      <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-0.5">
        <span className="truncate font-medium" title={file.name}>
          {file.name}
        </span>
        <span className="text-muted text-sm">
          {formatFileSize(file.size)}
          {' · '}
          {isMine ? 'added by you' : 'added by a member'}
          {' · '}
          <time dateTime={file.createdAt}>{formatRelativeTime(file.createdAt)}</time>
        </span>
        {downloadError !== null && (
          <span className="text-danger text-sm" role="alert">
            {downloadError}
          </span>
        )}
      </div>

      {status.kind === 'processing' && (
        <Chip color="default" variant="soft" size="sm">
          <Spinner size="sm" aria-hidden="true" />
          <Chip.Label>Processing</Chip.Label>
        </Chip>
      )}
      {status.kind === 'failed' && (
        <Tooltip delay={0}>
          <Tooltip.Trigger
            tabIndex={0}
            className="focus-visible:ring-focus rounded-full outline-none focus-visible:ring-2"
          >
            <Chip color="warning" variant="soft" size="sm">
              <WarningIcon />
              <Chip.Label>Processing failed</Chip.Label>
            </Chip>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <Tooltip.Arrow />
            {status.reason}
          </Tooltip.Content>
        </Tooltip>
      )}

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="tertiary"
          size="sm"
          isDisabled={isDownloading}
          onPress={() => {
            void download();
          }}
        >
          <DownloadIcon />
          Download
        </Button>
        {canDelete && (
          <Button variant="tertiary" size="sm" onPress={() => onDelete(file)}>
            <TrashIcon />
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The thumbnail once there is one, else a type icon. Fetched with the bearer header into an
 * object URL because an `<img src>` cannot carry the token; revoked when the row unmounts or
 * the thumbnail changes so the blob does not outlive the row.
 */
function Thumbnail({ token, file }: { token: string; file: MeetingFile }) {
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
