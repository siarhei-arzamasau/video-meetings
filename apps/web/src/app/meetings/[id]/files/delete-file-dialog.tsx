'use client';

import { Alert, Button, Modal } from '@heroui/react';
import type { MeetingFile } from '@repo/shared';
import { useState } from 'react';

import { WarningIcon } from '@/components/icons';
import { ApiError, deleteMeetingFile } from '@/lib/api-client';
import { describeFailure } from '@/lib/use-signed-in';

interface DeleteFileDialogProps {
  token: string;
  file: MeetingFile;
  onDeleted(fileId: string): void;
  onClose(): void;
  onUnauthorized(): void;
}

/**
 * The confirm step behind Delete, naming the file. `alertdialog` because it interrupts with a
 * choice that cannot be undone; the danger action is the one that needs a second look, so it
 * is not the default-focused control.
 */
export function DeleteFileDialog({
  token,
  file,
  onDeleted,
  onClose,
  onUnauthorized,
}: DeleteFileDialogProps) {
  const [submission, setSubmission] = useState<
    { state: 'idle' } | { state: 'deleting' } | { state: 'failed'; message: string }
  >({ state: 'idle' });
  const isDeleting = submission.state === 'deleting';

  async function confirm() {
    setSubmission({ state: 'deleting' });

    try {
      await deleteMeetingFile(token, file.meetingId, file.id);
      onDeleted(file.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized();

        return;
      }

      if (error instanceof ApiError && error.status === 404) {
        // Already gone — deleted by the host meanwhile, say. The outcome the user wanted.
        onDeleted(file.id);

        return;
      }

      setSubmission({ state: 'failed', message: describeFailure(error) });
    }
  }

  return (
    <Modal.Backdrop
      isOpen
      isDismissable={!isDeleting}
      onOpenChange={(open) => {
        if (!open && !isDeleting) {
          onClose();
        }
      }}
    >
      <Modal.Container>
        <Modal.Dialog role="alertdialog" className="sm:max-w-[400px]">
          <Modal.Header>
            <Modal.Heading>Delete this file?</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <p className="text-pretty">{`Delete "${file.name}"? People in this meeting will no longer see it.`}</p>
            {submission.state === 'failed' && (
              <Alert status="danger" role="alert" className="mt-4">
                <Alert.Indicator>
                  <WarningIcon />
                </Alert.Indicator>
                <Alert.Content>
                  <Alert.Title>We could not delete the file</Alert.Title>
                  <Alert.Description>{submission.message}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" isDisabled={isDeleting} onPress={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              isDisabled={isDeleting}
              onPress={() => {
                void confirm();
              }}
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
