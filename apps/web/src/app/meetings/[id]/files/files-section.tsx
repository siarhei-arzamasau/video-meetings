'use client';

import { Alert, Button, Card, EmptyState, Separator, Skeleton } from '@heroui/react';
import type { Meeting, MeetingFile, User } from '@repo/shared';
import { useEffect, useRef, useState } from 'react';

import { FileIcon, PlusIcon, WarningIcon } from '@/components/icons';
import {
  acceptAttribute,
  isProcessing,
  processingAnnouncement,
  sortNewestFirst,
} from '@/lib/meeting-files';
import { DeleteFileDialog } from './delete-file-dialog';
import { FileRow } from './file-row';
import { UploadRow } from './upload-row';
import { useDropTarget } from './use-drop-target';
import { useMeetingFiles } from './use-meeting-files';
import { useUploadQueue } from './use-upload-queue';

interface FilesSectionProps {
  token: string;
  meeting: Meeting;
  user: User;
  onUnauthorized(): void;
}

/**
 * The files of a meeting: the list, an upload queue that feeds it, and a drop target.
 *
 * Three hooks hold what moves — `useMeetingFiles` the list and its stream, `useUploadQueue`
 * the rows waiting to be sent, `useDropTarget` the drag state — and this component is what
 * remains: which of them is rendered, and the announcement that follows the list.
 *
 * Pick and drop go through one `enqueue`, and a finished upload goes straight into the list
 * through `add`. The queue is rendered on `uploads.length` rather than on the list being
 * ready, because an upload the user just started must show its progress, its Cancel, or its
 * rejection even while the list behind it is still loading or failed to load.
 */
export function FilesSection({ token, meeting, user, onUnauthorized }: FilesSectionProps) {
  const { list, refresh, add, replace, remove } = useMeetingFiles(
    token,
    meeting.id,
    onUnauthorized,
  );
  const { uploads, enqueue, cancel, dismiss, retry } = useUploadQueue({
    token,
    meetingId: meeting.id,
    onUploaded: add,
    onUnauthorized,
  });
  const { isDragging, handlers } = useDropTarget(enqueue);
  const [deleting, setDeleting] = useState<MeetingFile | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const files = list.state === 'ready' ? sortNewestFirst(list.files) : [];
  const processingCount = files.filter((file) => isProcessing([file])).length;
  const isEmpty = list.state === 'ready' && files.length === 0 && uploads.length === 0;
  // The queue is shown whenever it has rows, even while the list is loading or failed to load:
  // an upload the user just started must show its progress, its Cancel, or its rejection.
  const showRows = uploads.length > 0 || (list.state === 'ready' && !isEmpty);

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
      {...handlers}
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
