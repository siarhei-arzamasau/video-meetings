'use client';

import type { MeetingFile } from '@repo/shared';
import { useEffect, useRef, useState } from 'react';

import { ApiError, abortUpload, uploadMeetingFile } from '@/lib/api-client';
import { fingerprint, uploadInChunks } from '@/lib/chunked-upload';
import { isChunkedUpload, validateFileBeforeUpload } from '@/lib/meeting-files';
import {
  forgetUploadSession,
  recallUploadSession,
  rememberUploadSession,
} from '@/lib/upload-sessions';
import { describeFailure } from '@/lib/use-signed-in';
import type { QueuedUpload } from './upload-row';

export interface UploadQueue {
  uploads: ReadonlyArray<QueuedUpload>;
  /** Pick and drop both land here, with the client-side checks applied on the way in. */
  enqueue(files: Iterable<File>): void;
  cancel(localId: string): void;
  dismiss(localId: string): void;
  retry(localId: string): void;
}

export interface UploadQueueOptions {
  token: string;
  meetingId: string;
  /** Called with the finished file, to put it into the list the section renders. */
  onUploaded(file: MeetingFile): void;
  onUnauthorized(): void;
}

/**
 * The upload queue behind `FilesSection`: the rows, and the runner that sends them one at a
 * time — the PRD's "one rejection does not lose the rest". A file rejected by the client-side
 * checks lands as a failed row without a round trip; a success is handed to `onUploaded` and
 * its row removed; a failure keeps its row and its message.
 *
 * A file over the single-request cap goes through `uploadInChunks` instead, and the only
 * difference a caller sees is that such a row carries a session id: Cancel tells the server to
 * drop it, Retry resumes it, and the id is remembered under the file's fingerprint so a reload
 * can resume it too once the user picks the same file again.
 */
export function useUploadQueue({
  token,
  meetingId,
  onUploaded,
  onUnauthorized,
}: UploadQueueOptions): UploadQueue {
  const [uploads, setUploads] = useState<QueuedUpload[]>([]);
  // A counter, not `crypto.randomUUID()`: that exists only in secure contexts, and a dev
  // server opened over plain HTTP from a phone is not one. The id only has to be unique
  // within this queue's lifetime.
  const nextLocalId = useRef(0);

  function patch(localId: string, changes: Partial<QueuedUpload>) {
    setUploads((current) =>
      current.map((upload) => (upload.localId === localId ? { ...upload, ...changes } : upload)),
    );
  }

  function dismiss(localId: string) {
    setUploads((current) => current.filter((upload) => upload.localId !== localId));
  }

  function enqueue(files: Iterable<File>) {
    const queued = [...files].map((file): QueuedUpload => {
      const error = validateFileBeforeUpload(file);
      nextLocalId.current += 1;

      return {
        localId: String(nextLocalId.current),
        file,
        status: error === null ? 'queued' : 'failed',
        progress: null,
        controller: new AbortController(),
        error,
        uploadId: null,
        resuming: false,
        // A file this app rejected without asking the server would be rejected again.
        canRetry: false,
      };
    });

    setUploads((current) => [...current, ...queued]);
  }

  function cancel(localId: string) {
    const upload = uploads.find((candidate) => candidate.localId === localId);
    upload?.controller.abort();

    if (upload !== undefined && upload.uploadId !== null) {
      forgetUploadSession(fingerprint(upload.file));
      // Best effort: an abort that does not arrive costs the session its TTL on the server,
      // after which the worker removes the chunks anyway. There is nothing to tell the user.
      void abortUpload(token, meetingId, upload.uploadId).catch(() => undefined);
    }

    dismiss(localId);
  }

  /**
   * Another attempt at a chunked upload that failed after its session existed. The runner
   * picks the row up again and `uploadInChunks` resumes from the remembered session, so a
   * retry costs the chunks that did not land, not the whole file.
   */
  function retry(localId: string) {
    patch(localId, { status: 'queued', error: null, canRetry: false });
  }

  // The runner: whenever nothing is in flight and something is waiting, start it. Keyed on the
  // queue itself, so a finished upload starts the next one and a cancel does too.
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
    const key = fingerprint(next.file);
    const onProgress = (fraction: number) => patch(next.localId, { progress: fraction });
    const started = chunked
      ? uploadInChunks(token, meetingId, next.file, {
          signal: next.controller.signal,
          onProgress,
          resumeFrom: recallUploadSession(key) ?? undefined,
          onSession: (uploadId) => {
            rememberUploadSession(key, uploadId);
            patch(next.localId, { uploadId });
          },
          onResume: () => patch(next.localId, { resuming: true }),
        })
      : uploadMeetingFile(token, meetingId, next.file, {
          signal: next.controller.signal,
          onProgress,
        });

    void started
      .then((file) => {
        if (chunked) {
          forgetUploadSession(key);
        }

        onUploaded(file);
        dismiss(next.localId);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Cancel already removed the row.
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

  return { uploads, enqueue, cancel, dismiss, retry };
}
