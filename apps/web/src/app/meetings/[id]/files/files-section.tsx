'use client';

import { Alert, Button, Card, EmptyState, Separator, Skeleton } from '@heroui/react';
import type { Meeting, MeetingFile, User } from '@repo/shared';
import { useRef, useState } from 'react';

import { FileIcon, PlusIcon, WarningIcon } from '@/components/icons';
import { acceptAttribute, sortNewestFirst } from '@/lib/meeting-files';
import { DeleteFileDialog } from './delete-file-dialog';
import { FileRow } from './file-row';
import { FilesAnnouncement } from './files-announcement';
import { UploadRow } from './upload-row';
import { useDropTarget } from './use-drop-target';
import type { MeetingFiles } from './use-meeting-files';
import { useUploadQueue } from './use-upload-queue';

/** One array for every render without a list, so nothing downstream sees it change. */
const NO_FILES: ReadonlyArray<MeetingFile> = [];

interface FilesSectionProps {
  token: string;
  meeting: Meeting;
  user: User;
  /** The list and its three edits, from the page: it holds the stream that keeps them current. */
  files: MeetingFiles;
  onUnauthorized(): void;
}

/**
 * The files of a meeting: the list, an upload queue that feeds it, and a drop target.
 *
 * Four hooks hold what moves — `useMeetingFiles` the list and its stream, called by the page
 * and handed in as `files`; `useUploadQueue` the rows waiting to be sent, `useDropTarget` the
 * drag state, `useFilesAnnouncement` what a screen reader is told as the list changes — and
 * this component is what remains: which of them is rendered.
 *
 * Pick and drop go through one `enqueue`, and a finished upload goes straight into the list
 * through `add`. The queue is rendered on `uploads.length` rather than on the list being
 * ready, because an upload the user just started must show its progress, its Cancel, or its
 * rejection even while the list behind it is still loading or failed to load.
 */
export function FilesSection({ token, meeting, user, files, onUnauthorized }: FilesSectionProps) {
  const { list, refresh, add, remove } = files;
  const { uploads, enqueue, cancel, dismiss, retry } = useUploadQueue({
    token,
    meetingId: meeting.id,
    onUploaded: add,
    onUnauthorized,
  });
  const { isDragging, handlers } = useDropTarget(enqueue);
  const [deleting, setDeleting] = useState<MeetingFile | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const listed = list.state === 'ready' ? list.files : NO_FILES;
  const rows = sortNewestFirst(listed);
  const isEmpty = list.state === 'ready' && rows.length === 0 && uploads.length === 0;
  // The queue is shown whenever it has rows, even while the list is loading or failed to load:
  // an upload the user just started must show its progress, its Cancel, or its rejection.
  const showRows = uploads.length > 0 || (list.state === 'ready' && !isEmpty);

  return (
    <Card
      data-testid="files-drop-target"
      className={`gap-0 p-6 transition-shadow ${isDragging ? 'ring-accent ring-2 ring-offset-2' : ''}`}
      {...handlers}
    >
      <FilesAnnouncement files={listed} />

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
          {rows.map((file, index) => (
            <li key={file.id} className="flex flex-col">
              {(index > 0 || uploads.length > 0) && <Separator className="my-1" />}
              <FileRow
                token={token}
                file={file}
                isMine={file.uploaderId === user.id}
                canManage={file.uploaderId === user.id || meeting.hostId === user.id}
                onDelete={setDeleting}
                // Both refetch. A retry's answer cannot be put in order against the stream,
                // and a list can: see `useRetry`.
                onRetried={refresh}
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
