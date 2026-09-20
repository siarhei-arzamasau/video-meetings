'use client';

import { Alert, Button, Card, EmptyState, Separator, Skeleton } from '@heroui/react';
import type { Meeting, MeetingFile, User } from '@repo/shared';
import type { DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { FileIcon, PlusIcon, WarningIcon } from '@/components/icons';
import { ApiError, abortUpload, uploadMeetingFile } from '@/lib/api-client';
import { fingerprint, uploadInChunks } from '@/lib/chunked-upload';
import {
  acceptAttribute,
  isChunkedUpload,
  isProcessing,
  processingAnnouncement,
  sortNewestFirst,
  validateFileBeforeUpload,
} from '@/lib/meeting-files';
import {
  forgetUploadSession,
  recallUploadSession,
  rememberUploadSession,
} from '@/lib/upload-sessions';
import { describeFailure } from '@/lib/use-signed-in';
import { DeleteFileDialog } from './delete-file-dialog';
import { FileRow } from './file-row';
import { UploadRow } from './upload-row';
import type { QueuedUpload } from './upload-row';
import { useMeetingFiles } from './use-meeting-files';

interface FilesSectionProps {
  token: string;
  meeting: Meeting;
  user: User;
  onUnauthorized(): void;
}

/**
 * The files of a meeting: the list, an upload queue that feeds it, and a drop target.
 *
 * Pick and drop go through one `enqueue`. The queue runs one upload at a time — the PRD's
 * "one rejection does not lose the rest" — with the client-side checks applied on the way
 * in so an oversized or wrong-typed file lands as a failed row without a round trip. A
 * success is put straight into the list; a failure stays on its row with its message.
 *
 * A file over the single-request cap goes through `uploadInChunks` instead, and the only
 * difference the rest of this component sees is that such a row carries a session id: Cancel
 * tells the server to drop it, Retry resumes it, and the id is remembered under the file's
 * fingerprint so a reload can resume it too once the user picks the same file again.
 */
export function FilesSection({ token, meeting, user, onUnauthorized }: FilesSectionProps) {
  const { list, refresh, add, replace, remove } = useMeetingFiles(
    token,
    meeting.id,
    onUnauthorized,
  );
  const [uploads, setUploads] = useState<QueuedUpload[]>([]);
  const [deleting, setDeleting] = useState<MeetingFile | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // A counter, not `crypto.randomUUID()`: that exists only in secure contexts, and a dev
  // server opened over plain HTTP from a phone is not one. The id only has to be unique
  // within this section's lifetime.
  const nextLocalId = useRef(0);

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

  function patch(localId: string, changes: Partial<QueuedUpload>) {
    setUploads((current) =>
      current.map((upload) => (upload.localId === localId ? { ...upload, ...changes } : upload)),
    );
  }

  function dismiss(localId: string) {
    setUploads((current) => current.filter((upload) => upload.localId !== localId));
  }

  function cancel(localId: string) {
    const upload = uploads.find((candidate) => candidate.localId === localId);
    upload?.controller.abort();

    if (upload !== undefined && upload.uploadId !== null) {
      forgetUploadSession(fingerprint(upload.file));
      // Best effort: an abort that does not arrive costs the session its TTL on the server,
      // after which the worker removes the chunks anyway. There is nothing to tell the user.
      void abortUpload(token, meeting.id, upload.uploadId).catch(() => undefined);
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
      ? uploadInChunks(token, meeting.id, next.file, {
          signal: next.controller.signal,
          onProgress,
          resumeFrom: recallUploadSession(key) ?? undefined,
          onSession: (uploadId) => {
            rememberUploadSession(key, uploadId);
            patch(next.localId, { uploadId });
          },
          onResume: () => patch(next.localId, { resuming: true }),
        })
      : uploadMeetingFile(token, meeting.id, next.file, {
          signal: next.controller.signal,
          onProgress,
        });

    void started
      .then((file) => {
        if (chunked) {
          forgetUploadSession(key);
        }

        add(file);
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
    // `patch` and `dismiss` are stable state updaters wrapped in plain functions. `add` is in
    // the list because it changes with the list's readiness, and the effect bails out early
    // while an upload is in flight, so re-running it is free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads, token, meeting.id, add]);

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (hasFiles(event)) {
      event.preventDefault();
      setDragDepth((depth) => depth + 1);
    }
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (hasFiles(event)) {
      // Without this the browser navigates to the dropped file.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (hasFiles(event)) {
      setDragDepth((depth) => Math.max(0, depth - 1));
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) {
      return;
    }

    event.preventDefault();
    setDragDepth(0);
    enqueue(event.dataTransfer.files);
  }

  const files = list.state === 'ready' ? sortNewestFirst(list.files) : [];
  const processingCount = files.filter((file) => isProcessing([file])).length;
  const isEmpty = list.state === 'ready' && files.length === 0 && uploads.length === 0;
  // The queue is shown whenever it has rows, even while the list is loading or failed to load:
  // an upload the user just started must show its progress, its Cancel, or its rejection.
  const showRows = uploads.length > 0 || (list.state === 'ready' && !isEmpty);
  const isDragging = dragDepth > 0;

  // Announced only on a change, never on the first render: a live region that reads the
  // page's opening state aloud is noise. Derived from the list rather than from stream
  // events, so the poll fallback announces the same thing.
  const previousProcessing = useRef<number | null>(null);

  useEffect(() => {
    const previous = previousProcessing.current;
    previousProcessing.current = processingCount;

    if (previous !== null && previous !== processingCount) {
      setAnnouncement(processingAnnouncement(processingCount));
    }
  }, [processingCount]);

  return (
    <Card
      data-testid="files-drop-target"
      className={`gap-0 p-6 transition-shadow ${isDragging ? 'ring-accent ring-2 ring-offset-2' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* One polite region for the whole section. Since the page follows its files over a
          stream, a row settles, arrives, or vanishes with no action from the reader, and the
          chip going is a change only a sighted one sees. `aria-atomic`, so the phrase is read
          whole rather than as whatever word changed. */}
      <output className="sr-only" aria-atomic="true">
        {announcement}
      </output>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-lg font-semibold tracking-tight">Files</h2>
          <p className="text-muted text-sm">Drop files here, or pick them.</p>
        </div>

        <Button variant="primary" onPress={() => input.current?.click()}>
          <PlusIcon />
          Add file
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept={acceptAttribute()}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            if (event.target.files !== null) {
              enqueue(event.target.files);
            }

            // Reset, so picking the same file again fires `change` again.
            event.target.value = '';
          }}
        />
      </div>

      {list.state === 'loading' && (
        <div className="mt-6 flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      {list.state === 'failed' && (
        <Alert status="danger" role="alert" className="mt-6">
          <Alert.Indicator>
            <WarningIcon />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>We could not load the files</Alert.Title>
            <Alert.Description>{list.message}</Alert.Description>
          </Alert.Content>
          <Button variant="secondary" onPress={refresh}>
            Try again
          </Button>
        </Alert>
      )}

      {isEmpty && (
        <EmptyState className="mt-6 flex flex-col items-center gap-3 py-8 text-center">
          <span className="bg-accent/10 text-accent flex size-12 items-center justify-center rounded-full">
            <FileIcon />
          </span>
          <p className="text-muted max-w-sm text-sm text-pretty">
            No files yet. Add an agenda, a deck, or a recording.
          </p>
        </EmptyState>
      )}

      {showRows && (
        <ul className="mt-6 flex flex-col" aria-label="Files">
          {uploads.map((upload, index) => (
            <li key={upload.localId} className="flex flex-col">
              {index > 0 && <Separator className="my-1" />}
              <UploadRow upload={upload} onCancel={cancel} onDismiss={dismiss} onRetry={retry} />
            </li>
          ))}
          {files.map((file, index) => (
            <li key={file.id} className="flex flex-col">
              {(index > 0 || uploads.length > 0) && <Separator className="my-1" />}
              <FileRow
                token={token}
                file={file}
                isMine={file.uploaderId === user.id}
                canManage={file.uploaderId === user.id || meeting.hostId === user.id}
                onDelete={setDeleting}
                onRetried={replace}
                onStale={refresh}
                onUnauthorized={onUnauthorized}
              />
            </li>
          ))}
        </ul>
      )}

      {deleting !== null && (
        <DeleteFileDialog
          token={token}
          file={deleting}
          onDeleted={(fileId) => {
            remove(fileId);
            setDeleting(null);
          }}
          onClose={() => setDeleting(null)}
          onUnauthorized={onUnauthorized}
        />
      )}
    </Card>
  );
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.types].includes('Files');
}
