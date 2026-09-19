'use client';

import { Button, ProgressBar } from '@heroui/react';

import { CloseIcon, FileIcon } from '@/components/icons';
import { formatFileSize } from '@/lib/meeting-files';

export interface QueuedUpload {
  localId: string;
  file: File;
  status: 'queued' | 'uploading' | 'failed';
  /** A fraction in `[0, 1]` once the browser reports one; `null` means indeterminate. */
  progress: number | null;
  controller: AbortController;
  error: string | null;
}

interface UploadRowProps {
  upload: QueuedUpload;
  onCancel(localId: string): void;
  onDismiss(localId: string): void;
}

/**
 * An upload as a row in the same list as the files, so it lands where the file will. In
 * flight: a progress bar, indeterminate until the browser reports a length, and Cancel — there
 * is nothing to clean up server-side, because the record is written only after the bytes land.
 * Failed: the message, from the client check or the API verbatim, and Dismiss.
 */
export function UploadRow({ upload, onCancel, onDismiss }: UploadRowProps) {
  const { file, status, progress, error, localId } = upload;
  const label = `Uploading ${file.name}`;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className="bg-default text-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
        <FileIcon />
      </span>

      <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1">
        <span className="truncate font-medium" title={file.name}>
          {file.name}
        </span>
        {status === 'failed' ? (
          <span className="text-danger text-sm" role="alert">
            {error}
          </span>
        ) : (
          <>
            <span className="text-muted text-sm">
              {formatFileSize(file.size)}
              {' · '}
              {status === 'queued'
                ? 'Waiting'
                : progress === null
                  ? 'Uploading'
                  : `${String(Math.round(progress * 100))}%`}
            </span>
            <ProgressBar
              aria-label={label}
              size="sm"
              className="w-full"
              {...(progress === null ? { isIndeterminate: true } : { value: progress * 100 })}
            >
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
          </>
        )}
      </div>

      {status === 'failed' ? (
        <Button variant="tertiary" size="sm" onPress={() => onDismiss(localId)}>
          <CloseIcon />
          Dismiss
        </Button>
      ) : (
        <Button variant="tertiary" size="sm" onPress={() => onCancel(localId)}>
          <CloseIcon />
          Cancel
        </Button>
      )}
    </div>
  );
}
