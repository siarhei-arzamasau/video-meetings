'use client';

import { Button, Chip, Spinner, Tooltip } from '@heroui/react';
import type { MeetingFile } from '@repo/shared';
import { useState } from 'react';

import { CloseIcon, DownloadIcon, RetryIcon, TrashIcon, WarningIcon } from '@/components/icons';
import { ApiError, downloadMeetingFile } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/date-time';
import { retryTargetOf } from '@/lib/meeting-file-retry';
import { formatFileSize, statusPresentation, transcriptionPresentation } from '@/lib/meeting-files';
import { Thumbnail } from './thumbnail';
import { TranscriptionStatus } from './transcription-status';
import { useRetry } from './use-retry';
import { useTranscript } from './use-transcript';

interface FileRowProps {
  token: string;
  file: MeetingFile;
  isMine: boolean;
  /**
   * The uploader-or-host gate. Delete, the file's retry, and the transcription's retry are
   * gated the same way, so one flag covers all three.
   */
  canManage: boolean;
  onDelete(file: MeetingFile): void;
  /** The API took the retry: refetch, because its answer may be older than the row is. */
  onRetried(): void;
  /** Someone else moved the file meanwhile: refetch rather than guess what it is now. */
  onStale(): void;
  onUnauthorized(): void;
}

export function FileRow({
  token,
  file,
  isMine,
  canManage,
  onDelete,
  onRetried,
  onStale,
  onUnauthorized,
}: FileRowProps) {
  const status = statusPresentation(file);
  const transcription = transcriptionPresentation(file);
  const transcript = useTranscript(token, file, onUnauthorized);
  const retry = useRetry(token, file, { onRetried, onStale, onUnauthorized });
  // The file's retry or the transcription's, never both: see `retryTargetOf`.
  const retryTarget = retryTargetOf(file);
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
        {retry.error !== null && (
          <span className="text-danger text-sm" role="alert">
            {retry.error}
          </span>
        )}
        {transcript.error !== null && (
          <span className="text-danger text-sm" role="alert">
            {transcript.error}
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

      {/* Beside the file's own status, never instead of it: a recording is ready, and can be
          downloaded, the whole time its transcription is queued, running, or failed. */}
      <TranscriptionStatus
        transcription={transcription}
        isOpening={transcript.isOpening}
        onOpen={transcript.open}
      />

      {/* `flex-wrap`: four actions — Retry and Dismiss beside the two every row has — are wider
          than a phone, and a group that cannot wrap pushes Delete off the page. */}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
        {retryTarget !== null && canManage && (
          <Button
            variant="secondary"
            size="sm"
            isDisabled={retry.isRetrying}
            onPress={() => retry.retry(retryTarget)}
          >
            {retry.isRetrying ? <Spinner size="sm" aria-hidden="true" /> : <RetryIcon />}
            Retry
          </Button>
        )}
        {(retry.error !== null || transcript.error !== null) && (
          <Button
            variant="tertiary"
            size="sm"
            onPress={() => {
              retry.dismiss();
              transcript.dismiss();
            }}
          >
            <CloseIcon />
            Dismiss
          </Button>
        )}
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
        {canManage && (
          <Button variant="tertiary" size="sm" onPress={() => onDelete(file)}>
            <TrashIcon />
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}
