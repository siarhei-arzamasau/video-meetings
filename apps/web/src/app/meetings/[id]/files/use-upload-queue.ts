'use client';

import type { MeetingFile } from '@repo/shared';
import { useEffect, useRef, useState } from 'react';

import { abortUpload } from '@/lib/api-client';
import { fingerprint } from '@/lib/chunked-upload';
import { validateFileBeforeUpload } from '@/lib/meeting-files';
import { forgetUploadSession } from '@/lib/upload-sessions';
import type { QueuedUpload } from './upload-row';
import { useUploadRunner } from './use-upload-runner';

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
 * The upload queue behind `FilesSection`: the rows, and — in `useUploadRunner` — the runner
 * that sends them one at a time, the PRD's "one rejection does not lose the rest". A file
 * rejected by the client-side checks lands as a failed row without a round trip; a success is
 * handed to `onUploaded` and its row removed; a failure keeps its row and its message.
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
    const queued = [...files].map((file) => {
      nextLocalId.current += 1;

      return toQueuedUpload(file, String(nextLocalId.current));
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

  useUploadRunner({ uploads, token, meetingId, onUploaded, onUnauthorized, patch, dismiss });
  useAbortOnUnmount(uploads);

  return { uploads, enqueue, cancel, dismiss, retry };
}

/**
 * Ends every upload when the queue goes away — "Back to your meetings", Log out, a 401.
 *
 * Nothing else would. An upload left running had no row and no Cancel, went on sending with
 * the token it was started with after the user had signed out, and — for a chunked one — was
 * joined by a second runner on the same session as soon as the user came back and picked the
 * file again, whose `complete` then answered 404 for a file that had uploaded.
 *
 * Only the request is ended. A chunked upload's session is neither dropped on the server nor
 * forgotten here, so picking the file again resumes it: leaving the page is not Cancel.
 */
function useAbortOnUnmount(uploads: ReadonlyArray<QueuedUpload>): void {
  const latest = useRef(uploads);

  useEffect(() => {
    latest.current = uploads;
  }, [uploads]);

  useEffect(
    () => () => {
      for (const upload of latest.current) {
        upload.controller.abort();
      }
    },
    [],
  );
}

/** A picked file as a row: waiting its turn, or already failed by the client-side checks. */
function toQueuedUpload(file: File, localId: string): QueuedUpload {
  const error = validateFileBeforeUpload(file);

  return {
    localId,
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
}
