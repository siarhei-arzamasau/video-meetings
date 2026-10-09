'use client';

import type { MeetingFile } from '@repo/shared';
import { useEffect } from 'react';

import { ApiError, uploadMeetingFile } from '@/lib/api-client';
import { fingerprint, uploadInChunks } from '@/lib/chunked-upload';
import { isChunkedUpload } from '@/lib/meeting-files';
import {
  forgetUploadSession,
  recallUploadSession,
  rememberUploadSession,
} from '@/lib/upload-sessions';
import { describeFailure } from '@/lib/use-signed-in';
import type { QueuedUpload } from './upload-row';

type PatchUpload = (localId: string, changes: Partial<QueuedUpload>) => void;

export interface UploadRunnerOptions {
  uploads: ReadonlyArray<QueuedUpload>;
  token: string;
  meetingId: string;
  onUploaded(file: MeetingFile): void;
  onUnauthorized(): void;
  patch: PatchUpload;
  dismiss(localId: string): void;
}

/**
 * The runner behind the upload queue: whenever nothing is in flight and something is waiting,
 * start it. Keyed on the queue itself, so a finished upload starts the next one and a cancel
 * does too.
 */
export function useUploadRunner({
  uploads,
  token,
  meetingId,
  onUploaded,
  onUnauthorized,
  patch,
  dismiss,
}: UploadRunnerOptions): void {
  useEffect(() => {
    if (uploads.some((upload) => upload.status === 'uploading')) {
      return;
    }

    const next = uploads.find((upload) => upload.status === 'queued');

    if (next === undefined) {
      return;
    }

    patch(next.localId, { status: 'uploading' });

    const chunked = isChunkedUpload(next.file);

    void send(next, chunked, { token, meetingId, patch })
      .then((file) => {
        onUploaded(file);
        dismiss(next.localId);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Cancel already removed the row, or the page that showed it has gone.
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();

          return;
        }

        // A chunked upload keeps its session, so Retry resumes rather than starts over.
        patch(next.localId, {
          status: 'failed',
          error: describeFailure(error),
          canRetry: chunked,
        });
      });
    // `patch` and `dismiss` are stable state updaters wrapped in plain functions.
    // `onUploaded` is in the list because it changes with the list's readiness, and the effect
    // bails out early while an upload is in flight, so re-running it is free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads, token, meetingId, onUploaded]);
}

/**
 * One file on its way, by whichever route its size asks for. A chunked upload remembers its
 * session under the file's fingerprint while it runs and forgets it once the file exists.
 */
async function send(
  next: QueuedUpload,
  chunked: boolean,
  { token, meetingId, patch }: Pick<UploadRunnerOptions, 'token' | 'meetingId' | 'patch'>,
): Promise<MeetingFile> {
  const onProgress = (fraction: number): void => patch(next.localId, { progress: fraction });

  if (!chunked) {
    return uploadMeetingFile(token, meetingId, next.file, {
      signal: next.controller.signal,
      onProgress,
    });
  }

  const key = fingerprint(next.file);
  const file = await uploadInChunks(token, meetingId, next.file, {
    signal: next.controller.signal,
    onProgress,
    resumeFrom: recallUploadSession(key) ?? undefined,
    onSession: (uploadId) => {
      rememberUploadSession(key, uploadId);
      patch(next.localId, { uploadId });
    },
    onResume: () => patch(next.localId, { resuming: true }),
  });

  forgetUploadSession(key);

  return file;
}
